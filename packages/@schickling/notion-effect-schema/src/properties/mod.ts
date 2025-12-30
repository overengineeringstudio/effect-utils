// Re-export all property modules

// Common types shared across property modules
export {
  SelectOption,
  type SelectOption as SelectOptionType,
  SelectOptionWrite,
  type SelectOptionWrite as SelectOptionWriteType,
  TextRichTextWrite,
  type TextRichTextWrite as TextRichTextWriteType,
} from './common.ts'

// Text properties (Title, RichText)
export {
  Title,
  TitleProperty,
  type TitleProperty as TitlePropertyType,
  TitleWrite,
  type TitleWrite as TitleWriteType,
  TitleWriteFromString,
  RichTextProp,
  RichTextProperty,
  type RichTextProperty as RichTextPropertyType,
  RichTextWrite,
  type RichTextWrite as RichTextWriteType,
  RichTextWriteFromString,
} from './text.ts'

// Number property
export {
  Num,
  NumberProperty,
  type NumberProperty as NumberPropertyType,
  NumberWrite,
  type NumberWrite as NumberWriteType,
  NumberWriteFromNumber,
} from './number.ts'

// Boolean property (Checkbox)
export {
  Checkbox,
  CheckboxProperty,
  type CheckboxProperty as CheckboxPropertyType,
  CheckboxWrite,
  type CheckboxWrite as CheckboxWriteType,
  CheckboxWriteFromBoolean,
} from './boolean.ts'

// Select properties (Select, MultiSelect, Status)
export {
  Select,
  SelectProperty,
  type SelectProperty as SelectPropertyType,
  SelectWrite,
  type SelectWrite as SelectWriteType,
  SelectWriteFromName,
  MultiSelect,
  MultiSelectProperty,
  type MultiSelectProperty as MultiSelectPropertyType,
  MultiSelectWrite,
  type MultiSelectWrite as MultiSelectWriteType,
  MultiSelectWriteFromNames,
  Status,
  StatusProperty,
  type StatusProperty as StatusPropertyType,
  StatusWrite,
  type StatusWrite as StatusWriteType,
  StatusWriteFromName,
} from './select.ts'

// Date property
export {
  DateProp,
  DateProperty,
  type DateProperty as DatePropertyType,
  DateValue,
  type DateValue as DateValueType,
  DateValueWrite,
  type DateValueWrite as DateValueWriteType,
  DateWrite,
  type DateWrite as DateWriteType,
  DateWriteFromStart,
} from './date.ts'

// Contact properties (Url, Email, PhoneNumber)
export {
  Url,
  UrlProperty,
  type UrlProperty as UrlPropertyType,
  UrlWrite,
  type UrlWrite as UrlWriteType,
  UrlWriteFromString,
  Email,
  EmailProperty,
  type EmailProperty as EmailPropertyType,
  EmailWrite,
  type EmailWrite as EmailWriteType,
  EmailWriteFromString,
  PhoneNumber,
  PhoneNumberProperty,
  type PhoneNumberProperty as PhoneNumberPropertyType,
  PhoneNumberWrite,
  type PhoneNumberWrite as PhoneNumberWriteType,
  PhoneNumberWriteFromString,
} from './contact.ts'

// Reference properties (People, Relation, Files)
export {
  People,
  PeopleProperty,
  type PeopleProperty as PeoplePropertyType,
  PeopleWrite,
  type PeopleWrite as PeopleWriteType,
  PeopleWriteFromIds,
  Relation,
  RelationProperty,
  type RelationProperty as RelationPropertyType,
  RelationWrite,
  type RelationWrite as RelationWriteType,
  RelationWriteFromIds,
  Files,
  FilesProperty,
  type FilesProperty as FilesPropertyType,
  FilesWrite,
  type FilesWrite as FilesWriteType,
  FilesWriteFromUrls,
  FileObject,
  type FileObject as FileObjectType,
  ExternalFile,
  type ExternalFile as ExternalFileType,
  NotionFile,
  type NotionFile as NotionFileType,
} from './reference.ts'

// Computed properties (Formula, UniqueId) - read-only
export {
  Formula,
  FormulaProperty,
  type FormulaProperty as FormulaPropertyType,
  FormulaValue,
  type FormulaValue as FormulaValueType,
  UniqueId,
  UniqueIdProperty,
  type UniqueIdProperty as UniqueIdPropertyType,
} from './computed.ts'

// Audit properties (CreatedTime, CreatedBy, LastEditedTime, LastEditedBy) - read-only
export {
  CreatedTime,
  CreatedTimeProperty,
  type CreatedTimeProperty as CreatedTimePropertyType,
  CreatedBy,
  CreatedByProperty,
  type CreatedByProperty as CreatedByPropertyType,
  LastEditedTime,
  LastEditedTimeProperty,
  type LastEditedTimeProperty as LastEditedTimePropertyType,
  LastEditedBy,
  LastEditedByProperty,
  type LastEditedByProperty as LastEditedByPropertyType,
} from './audit.ts'
