// Run with PLAYWRIGHT_BROWSERS_PATH set to a browser selector and pass the
// playwright-driver output path as argv[2]. channel=chromium exercises the
// full app bundle, not the separate headless-shell component.
const assert = require('node:assert/strict')
const { chromium } = require(process.argv[2])

;(async () => {
  const browser = await chromium.launch({ channel: 'chromium', headless: true })
  try {
    const page = await browser.newPage()
    await page.setContent('<title>bundle smoke</title><canvas></canvas>')
    assert.equal(await page.title(), 'bundle smoke')
    assert.equal(await page.evaluate(() => 6 * 7), 42)
    console.log('PASS: full Chromium launch, renderer evaluation, and close')
  } finally {
    await browser.close()
  }
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
