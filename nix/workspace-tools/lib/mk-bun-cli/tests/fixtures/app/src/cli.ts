import { sharedMessage } from 'shared-lib'

const buildVersion = '__CLI_VERSION__'

const main = () => {
  const args = process.argv.slice(2)
  if (args.includes('--log-level')) {
    console.error('unknown option: --log-level')
    process.exit(2)
  }

  const completionsIndex = args.indexOf('--completions')
  if (completionsIndex !== -1) {
    const shell = args[completionsIndex + 1] ?? 'unknown'
    console.log(`# ${shell} completions for app-cli`)
    return
  }

  console.log(`app-cli ${buildVersion}: ${sharedMessage}`)
}

main()
