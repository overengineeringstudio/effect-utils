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
  email: Schema.optionalWith(
    Schema.String.annotations({
      examples: ['user@example.com'],
    }),
    { as: 'Option' },
  ).annotations({
    description: 'Email address of the person. Only present with proper capabilities.',
  }),
}).annotations({
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
  object: Schema.Literal('user').annotations({
    description: 'Always "user" for user objects.',
  }),
  id: NotionUUID.annotations({
    description: 'Unique identifier for this user.',
  }),
  type: Schema.Literal('person').annotations({
    description: 'Type identifier for person users.',
  }),
  name: Schema.optionalWith(
    Schema.String.annotations({
      examples: ['Jane Doe'],
    }),
    { as: 'Option' },
  ).annotations({
    description: "User's name as displayed in Notion.",
  }),
  avatar_url: Schema.optionalWith(
    Schema.String.annotations({
      examples: ['https://s3.us-west-2.amazonaws.com/...'],
    }),
    { as: 'Option' },
  ).annotations({
    description: "URL of the user's avatar image.",
  }),
  person: PersonData,
}).annotations({
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
export const BotOwner = Schema.Union(
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
).annotations({
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
  owner: BotOwner.annotations({
    description: 'Owner of the bot (workspace or user).',
  }),
  workspace_name: Schema.optionalWith(Schema.String, { as: 'Option' }).annotations({
    description: 'Name of the workspace owning the bot.',
  }),
}).annotations({
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
  object: Schema.Literal('user').annotations({
    description: 'Always "user" for user objects.',
  }),
  id: NotionUUID.annotations({
    description: 'Unique identifier for this bot.',
  }),
  type: Schema.Literal('bot').annotations({
    description: 'Type identifier for bot users.',
  }),
  name: Schema.optionalWith(
    Schema.String.annotations({
      examples: ['My Integration'],
    }),
    { as: 'Option' },
  ).annotations({
    description: "Bot's name as displayed in Notion.",
  }),
  avatar_url: Schema.optionalWith(Schema.String, { as: 'Option' }).annotations({
    description: "URL of the bot's avatar image.",
  }),
  bot: BotData,
}).annotations({
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
  object: Schema.Literal('user').annotations({
    description: 'Always "user" for user objects.',
  }),
  id: NotionUUID.annotations({
    description: 'Unique identifier for this user.',
  }),
}).annotations({
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
export const User = Schema.Union(Person, Bot).annotations({
  identifier: 'Notion.User',
  title: 'User',
  description: 'A Notion user, which can be either a person or a bot.',
  [docsPath]: 'user',
})

export type User = typeof User.Type
