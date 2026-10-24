import type { GenieOutput } from '@overeng/genie'

import { generateSwift, type GeneratedFile, type SwiftGenerationInput } from './mod.ts'

/** One .swift.genie.ts owns exactly one generated Swift file. */
export const swiftFile = (input: SwiftGenerationInput): GenieOutput<GeneratedFile> => {
  const [file] = generateSwift(input)
  return { data: file, stringify: () => file.content }
}
