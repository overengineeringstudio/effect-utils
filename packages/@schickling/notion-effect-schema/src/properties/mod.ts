// Re-export all property modules

// Audit properties (CreatedTime, CreatedBy, LastEditedTime, LastEditedBy) - read-only
export {
  CreatedBy,
  CreatedByProperty,
  type CreatedByProperty as CreatedByPropertyType,
  CreatedTime,
  CreatedTimeProperty,
  type CreatedTimeProperty as CreatedTimePropertyType,
  LastEditedBy,
  LastEditedByProperty,
  type LastEditedByProperty as LastEditedByPropertyType,
  LastEditedTime,
  LastEditedTimeProperty,
  type LastEditedTimeProperty as LastEditedTimePropertyType,
} from './audit.ts'
// Boolean property (Checkbox)
export {
  Checkbox,
  CheckboxProperty,
  type CheckboxProperty as CheckboxPropertyType,
  CheckboxWrite,
  type CheckboxWrite as CheckboxWriteType,
  CheckboxWriteFromBoolean,
} from './boolean.ts'
// Common types shared across property modules
export {
  SelectOption,
  type SelectOption as SelectOptionType,
  SelectOptionWrite,
  type SelectOptionWrite as SelectOptionWriteType,
  TextRichTextWrite,
  type TextRichTextWrite as TextRichTextWriteType,
} from './common.ts'
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
// Contact properties (Url, Email, PhoneNumber)
export {
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
  Url,
  UrlProperty,
  type UrlProperty as UrlPropertyType,
  UrlWrite,
  type UrlWrite as UrlWriteType,
  UrlWriteFromString,
} from './contact.ts'

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
// Number property
export {
  Num,
  NumberProperty,
  type NumberProperty as NumberPropertyType,
  NumberWrite,
  type NumberWrite as NumberWriteType,
  NumberWriteFromNumber,
} from './number.ts'

// Reference properties (People, Relation, Files)
export {
  ExternalFile,
  type ExternalFile as ExternalFileType,
  FileObject,
  type FileObject as FileObjectType,
  Files,
  FilesProperty,
  type FilesProperty as FilesPropertyType,
  FilesWrite,
  type FilesWrite as FilesWriteType,
  FilesWriteFromUrls,
  NotionFile,
  type NotionFile as NotionFileType,
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
} from './reference.ts'
// Select properties (Select, MultiSelect, Status)
export {
  MultiSelect,
  MultiSelectProperty,
  type MultiSelectProperty as MultiSelectPropertyType,
  MultiSelectWrite,
  type MultiSelectWrite as MultiSelectWriteType,
  MultiSelectWriteFromNames,
  Select,
  SelectProperty,
  type SelectProperty as SelectPropertyType,
  SelectWrite,
  type SelectWrite as SelectWriteType,
  SelectWriteFromName,
  Status,
  StatusProperty,
  type StatusProperty as StatusPropertyType,
  StatusWrite,
  type StatusWrite as StatusWriteType,
  StatusWriteFromName,
} from './select.ts'
// Text properties (Title, RichText)
export {
  RichTextProp,
  RichTextProperty,
  type RichTextProperty as RichTextPropertyType,
  RichTextWrite,
  type RichTextWrite as RichTextWriteType,
  RichTextWriteFromString,
  Title,
  TitleProperty,
  type TitleProperty as TitlePropertyType,
  TitleWrite,
  type TitleWrite as TitleWriteType,
  TitleWriteFromString,
} from './text.ts'
