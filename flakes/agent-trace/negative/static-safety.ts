import type { PrivateFooterV2, PublicFooterV2 } from '../src/media.ts'
import { encodePublicFooter, encodePublicTrailer } from '../src/media.ts'
import type { SessionLookup } from '../src/schema.ts'
declare const privateView: PrivateFooterV2
declare const footerView: PublicFooterV2
encodePublicFooter(privateView)
encodePublicTrailer(footerView)
const rawSession: typeof SessionLookup.Type = '01a14e79-1234-1234-1234-0123456789ab'
void rawSession
