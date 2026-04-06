# Pokecord

## A thank you message

Thank you to the team at [interaction](https://interaction.co) for [Poke](https://poke.com), an amazing personal superintelligence that sits in your pocket..or in your discord!

Discord bridge for Poke, hosted 24/7. No self-hosting required:

- owner-private DMs for your own linked account
- DMs for each user who links their own Poke key
- guild installs with admin setup and channel allowlists
- group chats with a shared install and explicit `/poke send` activation

## Quick Start

1. Install the Poke [Recipe](https://poke.com/refer/znEEJgJ1DDx)
2. Install the bot with [this invite link](https://discord.com/oauth2/authorize?client_id=1488275565214433481).
3. For your own private use, open a DM with the bot and run `/poke setup`.
4. For a server, ask a server admin or owner to run `/poke setup`.
5. For a group chat, have any participant run `/poke setup`, then use `/poke send` to start the conversation.
6. Use `/poke status` or `!status` to confirm the link.
7. Send messages normally after setup.

## Setup

### Private Setup

For your personal owner namespace:

1. Open a DM with the bot.
2. Run `/poke setup`.
3. Paste your Poke API key into the modal.
4. Use `!status` or `!reset` if you need to check or clear the link.

### Public Server Setup

For a server:

1. A server admin or owner runs `/poke setup`.
2. Paste the server's Poke API key in the setup modal.
3. Choose the channels that should talk to Poke.
4. Use `/poke status` to confirm the enabled channels.
5. Only enabled channels will relay to Poke.

### Group Chat Setup

For a Discord group chat:

1. Any participant can run `/poke setup` in the group chat.
2. Paste the group chat's Poke API key in the setup modal.
3. Use `/poke send` to start a conversation.
4. Reply to Poke's messages to keep the conversation going.
5. Only the original installer can reset the group chat install.

## Commands

- DM mode:
  - `!status`
  - `!reset`
  - `/poke setup`
- Slash commands:
  - `/poke send`
  - `/poke setup`
  - `/poke status`
  - `/poke reset`

## Notes

- Poke will refuse to answer personal questions about who owns the API key or who is initially linked to the bot when used in guilds.
- The "Poke is typing..." is emulated and not actually Poke typing/thinking, until Interaction adds a way to see when Poke is working, this is emulated.
