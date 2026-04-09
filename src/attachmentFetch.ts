import { lookup as lookupHostname } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

const DEFAULT_ATTACHMENT_FETCH_TIMEOUT_MS = 10_000;
const DEFAULT_ATTACHMENT_MAX_BYTES = 8 * 1024 * 1024;
const MAX_REDIRECTS = 3;

const LOCAL_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "ip6-loopback"
]);

export interface AttachmentFetchOptions {
  fetchImpl?: typeof fetch;
  lookup?: AttachmentLookup;
  timeoutMs?: number;
  maxBytes?: number;
}

type AttachmentLookupResult = Array<{ address: string; family: number }>;
type AttachmentLookup = (hostname: string) => Promise<AttachmentLookupResult>;
type ResolvedAttachmentTarget = {
  url: URL;
  addresses: string[];
};

function ipv4ToNumber(address: string): number {
  return address.split(".").reduce((result, part) => (result << 8) + Number(part), 0);
}

export function isPrivateIpAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const numeric = ipv4ToNumber(address);
    const ranges = [
      ["0.0.0.0", "0.255.255.255"],
      ["10.0.0.0", "10.255.255.255"],
      ["127.0.0.0", "127.255.255.255"],
      ["169.254.0.0", "169.254.255.255"],
      ["172.16.0.0", "172.31.255.255"],
      ["192.168.0.0", "192.168.255.255"]
    ].map(([start, end]) => [ipv4ToNumber(start), ipv4ToNumber(end)] as const);

    return ranges.some(([start, end]) => numeric >= start && numeric <= end);
  }

  if (version === 6) {
    const normalized = address.toLowerCase();
    return normalized === "::1"
      || normalized.startsWith("fc")
      || normalized.startsWith("fd")
      || normalized.startsWith("fe8")
      || normalized.startsWith("fe9")
      || normalized.startsWith("fea")
      || normalized.startsWith("feb")
      || normalized.startsWith("::ffff:127.")
      || normalized.startsWith("::ffff:10.")
      || normalized.startsWith("::ffff:192.168.")
      || normalized.startsWith("::ffff:172.16.")
      || normalized.startsWith("::ffff:172.17.")
      || normalized.startsWith("::ffff:172.18.")
      || normalized.startsWith("::ffff:172.19.")
      || normalized.startsWith("::ffff:172.2")
      || normalized.startsWith("::ffff:172.30.")
      || normalized.startsWith("::ffff:172.31.")
      || normalized.startsWith("::ffff:169.254.");
  }

  return false;
}

export async function resolveSafeAttachmentTarget(
  rawUrl: string,
  lookup: AttachmentLookup = hostname => lookupHostname(hostname, { all: true, verbatim: true })
): Promise<ResolvedAttachmentTarget> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("Attachment URL must be a valid absolute URL.");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Attachment URL must use http or https.");
  }

  const hostname = parsed.hostname.trim().toLowerCase();
  if (!hostname) {
    throw new Error("Attachment URL hostname is required.");
  }

  if (LOCAL_HOSTNAMES.has(hostname) || hostname.endsWith(".local")) {
    throw new Error("Attachment URL points to a local or private host.");
  }

  if (isIP(hostname)) {
    if (isPrivateIpAddress(hostname)) {
      throw new Error("Attachment URL points to a local or private host.");
    }
    return {
      url: parsed,
      addresses: [hostname]
    };
  }

  const resolved = await lookup(hostname);
  if (!resolved.length) {
    throw new Error("Attachment URL host could not be resolved.");
  }

  if (resolved.some(entry => isPrivateIpAddress(entry.address))) {
    throw new Error("Attachment URL points to a local or private host.");
  }

  return {
    url: parsed,
    addresses: resolved.map(entry => entry.address)
  };
}

async function readResponseBuffer(response: Response, maxBytes: number): Promise<Buffer> {
  const contentLengthHeader = response.headers.get("content-length");
  if (contentLengthHeader) {
    const contentLength = Number(contentLengthHeader);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      throw new Error(`Attachment exceeds the ${maxBytes} byte limit.`);
    }
  }

  if (!response.body) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) {
      throw new Error(`Attachment exceeds the ${maxBytes} byte limit.`);
    }
    return buffer;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;

    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel();
      throw new Error(`Attachment exceeds the ${maxBytes} byte limit.`);
    }

    chunks.push(value);
  }

  return Buffer.concat(chunks.map(chunk => Buffer.from(chunk)));
}

function readNodeResponseBuffer(
  statusCode: number,
  headers: Record<string, string | string[] | undefined>,
  stream: NodeJS.ReadableStream,
  maxBytes: number
): Promise<Buffer> {
  const contentLengthHeader = headers["content-length"];
  const rawLength = Array.isArray(contentLengthHeader) ? contentLengthHeader[0] : contentLengthHeader;
  if (rawLength) {
    const contentLength = Number(rawLength);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      throw new Error(`Attachment exceeds the ${maxBytes} byte limit.`);
    }
  }

  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;

    stream.on("data", chunk => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.byteLength;
      if (totalBytes > maxBytes) {
        (stream as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
        reject(new Error(`Attachment exceeds the ${maxBytes} byte limit.`));
        return;
      }
      chunks.push(buffer);
    });
    stream.once("end", () => resolve(Buffer.concat(chunks)));
    stream.once("error", reject);
  });
}

async function performResolvedRequest(
  target: ResolvedAttachmentTarget,
  timeoutMs: number,
  maxBytes: number
): Promise<{ statusCode: number; headers: Record<string, string | string[] | undefined>; buffer: Buffer; location?: string }> {
  const address = target.addresses[0];
  if (!address) {
    throw new Error("Attachment URL host could not be resolved.");
  }

  const requestImpl = target.url.protocol === "https:" ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const request = requestImpl({
      protocol: target.url.protocol,
      hostname: address,
      port: target.url.port ? Number(target.url.port) : undefined,
      path: `${target.url.pathname}${target.url.search}`,
      method: "GET",
      headers: {
        Host: target.url.host
      },
      servername: target.url.hostname,
      timeout: timeoutMs
    }, response => {
      const statusCode = response.statusCode ?? 0;
      const location = response.headers.location;
      const redirectLocation = Array.isArray(location) ? location[0] : location;

      void readNodeResponseBuffer(statusCode, response.headers, response, maxBytes)
        .then(buffer => resolve({
          statusCode,
          headers: response.headers,
          buffer,
          ...(redirectLocation ? { location: redirectLocation } : {})
        }))
        .catch(reject);
    });

    request.once("timeout", () => {
      request.destroy(new Error("Attachment fetch timed out."));
    });
    request.once("error", reject);
    request.end();
  });
}

export async function assertSafeAttachmentUrl(
  rawUrl: string,
  lookup: AttachmentLookup = hostname => lookupHostname(hostname, { all: true, verbatim: true })
): Promise<URL> {
  return (await resolveSafeAttachmentTarget(rawUrl, lookup)).url;
}

export async function downloadAttachmentBuffer(
  rawUrl: string,
  options: AttachmentFetchOptions = {}
): Promise<Buffer> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const lookup = options.lookup ?? (hostname => lookupHostname(hostname, { all: true, verbatim: true }));
  const timeoutMs = options.timeoutMs ?? DEFAULT_ATTACHMENT_FETCH_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_ATTACHMENT_MAX_BYTES;

  let currentTarget = await resolveSafeAttachmentTarget(rawUrl, lookup);

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    try {
      if (!options.fetchImpl) {
        const response = await performResolvedRequest(currentTarget, timeoutMs, maxBytes);
        if (response.statusCode >= 300 && response.statusCode < 400) {
          if (!response.location) {
            throw new Error("Attachment redirect is missing a location.");
          }
          if (redirectCount === MAX_REDIRECTS) {
            throw new Error("Attachment redirect limit exceeded.");
          }

          currentTarget = await resolveSafeAttachmentTarget(new URL(response.location, currentTarget.url).toString(), lookup);
          continue;
        }

        if (response.statusCode < 200 || response.statusCode >= 300) {
          throw new Error(`Failed to fetch attachment ${currentTarget.url}: ${response.statusCode}`);
        }

        return response.buffer;
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetchImpl(currentTarget.url, {
          redirect: "manual",
          signal: controller.signal
        });

        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get("location");
          if (!location) {
            throw new Error("Attachment redirect is missing a location.");
          }
          if (redirectCount === MAX_REDIRECTS) {
            throw new Error("Attachment redirect limit exceeded.");
          }

          currentTarget = await resolveSafeAttachmentTarget(new URL(location, currentTarget.url).toString(), lookup);
          continue;
        }

        if (!response.ok) {
          throw new Error(`Failed to fetch attachment ${currentTarget.url}: ${response.status}`);
        }

        return await readResponseBuffer(response, maxBytes);
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          throw new Error("Attachment fetch timed out.");
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    } catch (error) {
      if (error instanceof Error && error.message === "Attachment fetch timed out.") {
        throw error;
      }
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error("Attachment fetch timed out.");
      }
      throw error;
    }
  }

  throw new Error("Attachment redirect limit exceeded.");
}
