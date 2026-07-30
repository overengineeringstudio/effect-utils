import { Schema } from 'effect'

import { docsPath, NotionUUID } from './common.ts'

// -----------------------------------------------------------------------------
// Person
// -----------------------------------------------------------------------------

/**
 * Person-specific properties for a user.
 *
 * @see https://developers.notion.com/reference/user#people
 */
export const PersonData = Schema.Struct({
  email: Schema.OptionFromOptional(
    Schema.String.annotate({
      examples: ['user@example.com'],
    }),
  ).annotate({
    description: 'Email address of the person. Only present with proper capabilities.',
  }),
}).annotate({
  identifier: 'Notion.PersonData',
  title: 'Person Data',
  description: 'Person-specific properties within a user object.',
  [docsPath]: 'user#people',
})

export type PersonData = typeof PersonData.Type

/**
 * A person-type user in Notion.
 *
 * @see https://developers.notion.com/reference/user#people
 */
export const Person = Schema.Struct({
  object: Schema.Literal('user').annotate({
    description: 'Always "user" for user objects.',
  }),
  id: NotionUUID.annotate({
    description: 'Unique identifier for this user.',
  }),
  type: Schema.Literal('person').annotate({
    description: 'Type identifier for person users.',
  }),
  name: Schema.OptionFromOptional(
    Schema.String.annotate({
      examples: ['Jane Doe'],
    }),
  ).annotate({
    description: "User's name as displayed in Notion.",
  }),
  avatar_url: Schema.OptionFromOptional(
    Schema.String.annotate({
      examples: ['https://s3.us-west-2.amazonaws.com/...'],
    }),
  ).annotate({
    description: "URL of the user's avatar image.",
  }),
  person: PersonData,
}).annotate({
  identifier: 'Notion.Person',
  title: 'Person',
  description: 'A human user in Notion.',
  [docsPath]: 'user#people',
})

export type Person = typeof Person.Type

// -----------------------------------------------------------------------------
// Bot
// -----------------------------------------------------------------------------

/**
 * Bot owner information.
 */
export const BotOwner = Schema.Union([
  Schema.Struct({
    type: Schema.Literal('workspace'),
    workspace: Schema.Literal(true),
  }),
  Schema.Struct({
    type: Schema.Literal('user'),
    user: Schema.Struct({
      object: Schema.Literal('user'),
      id: NotionUUID,
    }),
  }),
]).annotate({
  identifier: 'Notion.BotOwner',
  title: 'Bot Owner',
  description: 'The owner of a bot, either a workspace or a user.',
  [docsPath]: 'user#bots',
})

export type BotOwner = typeof BotOwner.Type

/**
 * Bot-specific properties for a user.
 *
 * @see https://developers.notion.com/reference/user#bots
 */
export const BotData = Schema.Struct({
  owner: BotOwner.annotate({
    description: 'Owner of the bot (workspace or user).',
  }),
  workspace_name: Schema.OptionFromOptional(Schema.String).annotate({
    description: 'Name of the workspace owning the bot.',
  }),
}).annotate({
  identifier: 'Notion.BotData',
  title: 'Bot Data',
  description: 'Bot-specific properties within a user object.',
  [docsPath]: 'user#bots',
})

export type BotData = typeof BotData.Type

/**
 * A bot-type user in Notion.
 *
 * @see https://developers.notion.com/reference/user#bots
 */
export const Bot = Schema.Struct({
  object: Schema.Literal('user').annotate({
    description: 'Always "user" for user objects.',
  }),
  id: NotionUUID.annotate({
    description: 'Unique identifier for this bot.',
  }),
  type: Schema.Literal('bot').annotate({
    description: 'Type identifier for bot users.',
  }),
  name: Schema.OptionFromOptional(
    Schema.String.annotate({
      examples: ['My Integration'],
    }),
  ).annotate({
    description: "Bot's name as displayed in Notion.",
  }),
  avatar_url: Schema.OptionFromOptional(Schema.String).annotate({
    description: "URL of the bot's avatar image.",
  }),
  bot: BotData,
}).annotate({
  identifier: 'Notion.Bot',
  title: 'Bot',
  description: 'A bot user (integration) in Notion.',
  [docsPath]: 'user#bots',
})

export type Bot = typeof Bot.Type

// -----------------------------------------------------------------------------
// Partial User (for mentions and references)
// -----------------------------------------------------------------------------

/**
 * A partial user object, used in mentions and references.
 * Contains only the id and object type.
 */
export const PartialUser = Schema.Struct({
  object: Schema.Literal('user').annotate({
    description: 'Always "user" for user objects.',
  }),
  id: NotionUUID.annotate({
    description: 'Unique identifier for this user.',
  }),
}).annotate({
  identifier: 'Notion.PartialUser',
  title: 'Partial User',
  description: 'A minimal user reference containing only the ID.',
  [docsPath]: 'user',
})

export type PartialUser = typeof PartialUser.Type

// -----------------------------------------------------------------------------
// User Union
// -----------------------------------------------------------------------------

/**
 * A Notion user, either a person or a bot.
 *
 * @see https://developers.notion.com/reference/user
 */
export const User = Schema.Union([Person, Bot]).annotate({
  identifier: 'Notion.User',
  title: 'User',
  description: 'A Notion user, which can be either a person or a bot.',
  [docsPath]: 'user',
})

export type User = typeof User.Type
