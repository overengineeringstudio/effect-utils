export function getPropertyValue(object: object, propertyName: string): unknown {
  const propertyDescriptor = Object.getOwnPropertyDescriptor(object, propertyName)
  if (propertyDescriptor !== undefined && propertyDescriptor.get !== undefined) {
    try {
      return propertyDescriptor.get()
    } catch {
      return propertyDescriptor.get
    }
  }

  return (object as Record<string, unknown>)[propertyName]
}
