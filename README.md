# Pokecord

## A thank you message

Thank you to the team at [interaction](https://interaction.co) for [Poke](https://poke.com), an amazing personal superintelligence that sits in your pocket..or in your discord!

Discord bridge for Poke, hosted 24/7. No self-hosting required:

- owner-private DMs for your own linked account
- DMs for each user who links their own Poke key
- guild installs with admin setup, channel allowlists, proactive replies, and optional unrestricted mode for trusted teams

## Quick Start

1. Install the Poke [Recipe](https://poke.com/refer/znEEJgJ1DDx)
2. Install the bot with [this invite link](https://discord.com/oauth2/authorize?client_id=1488275565214433481).
3. For your own private use, open a DM with the bot and run `/poke settings`.
4. For a server, ask a server admin or owner to open `/poke settings`.
5. Use the settings panel to link the server, enable channels, and configure proactive or unrestricted mode.
6. Send messages normally after setup.

## Setup

### Private Setup

For your personal owner namespace:

1. Open a DM with the bot.
2. Run `/poke settings`.
3. Paste your Poke API key into the modal.
4. Use the settings panel to check or clear the link.

### Public Server Setup

For a server:

1. A server admin or owner opens `/poke settings`.
2. Paste the server's Poke API key in the setup modal.
3. Enable the channels that should talk to Poke.
4. Use the same panel to configure proactive replies or turn on unrestricted mode for trusted private servers.
5. Only enabled channels will relay to Poke unless unrestricted mode is enabled.

## Commands

- DM mode:
  - `/poke settings`
- Slash commands:
  - `/poke send`
  - `/poke settings`

## Notes

- Poke will refuse to answer personal questions about who owns the API key or who is initially linked to the bot when used in guilds.
- The "Poke is typing..." is emulated and not actually Poke typing/thinking, until Interaction adds a way to see when Poke is working, this is emulated.
- Guilds can keep proactive replies on by default, but admins can disable them per server or per channel from `/poke settings`.
- Guilds can also enable unrestricted mode for trusted teams, including per-channel overrides.
