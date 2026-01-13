import { sharedMessage } from 'shared-lib'
import { utilMessage } from '@acme/utils'

const buildVersion = '__CLI_VERSION__'

const main = () => {
  console.log(`app-cli ${buildVersion}: ${sharedMessage} ${utilMessage}`)
}

main()
