import { utilMessage } from '@acme/utils'
import { sharedMessage } from 'shared-lib'

const buildVersion = '__CLI_VERSION__'

const main = () => {
  console.log(`app-cli ${buildVersion}: ${sharedMessage} ${utilMessage}`)
}

main()
