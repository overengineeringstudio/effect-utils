// ---------------------------------------------------------------------------
// click-to-copy (byte-exact from the raw model string — never DOM text)
// ---------------------------------------------------------------------------

export const fallbackCopy = (text: string, done: () => void): void => {
  const ta = document.createElement('textarea')
  ta.value = text
  ta.style.position = 'fixed'
  ta.style.opacity = '0'
  document.body.appendChild(ta)
  ta.select()
  try {
    document.execCommand('copy')
    done()
  } catch {
    /* ignore */
  }
  document.body.removeChild(ta)
}
