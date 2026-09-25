const invalidOrigin = (location: string): never => {
  throw new Error(`${location} must use an approved public HTTPS archive origin`)
}

/** Archive URLs and every redirect hop must stay on reviewed public HTTPS origins. */
export const publicArchiveUrl = ({ url, location }: { url: string; location: string }): string => {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return invalidOrigin(location)
  }
  const approved =
    (parsed.hostname === 'registry.npmjs.org' &&
      url.startsWith('https://registry.npmjs.org/')) ||
    (parsed.hostname === 'overeng-effect-utils.cachix.org' &&
      url.startsWith('https://overeng-effect-utils.cachix.org/serve/'))
  if (
    approved === false ||
    parsed.protocol !== 'https:' ||
    parsed.port !== '' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.hash !== ''
  )
    return invalidOrigin(location)
  return url
}

export const publicArchiveRedirectUrl = ({
  from,
  redirect,
}: {
  from: string
  redirect: string | null
}): string => {
  if (redirect === null) throw new Error(`archive redirect from ${from} has no Location`)
  let url: string
  try {
    url = new URL(redirect, from).href
  } catch {
    return invalidOrigin('archive redirect URL')
  }
  return publicArchiveUrl({ url, location: 'archive redirect URL' })
}
