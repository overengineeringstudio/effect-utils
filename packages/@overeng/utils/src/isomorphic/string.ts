/** Converts the first character of a string to lowercase */
export const lowercaseFirstChar = (str: string) => str.charAt(0).toLowerCase() + str.slice(1)

/** Converts the first character of a string to uppercase */
export const uppercaseFirstChar = (str: string) => str.charAt(0).toUpperCase() + str.slice(1)
