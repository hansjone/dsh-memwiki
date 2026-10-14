// Child-process-only test injection. There is no environment switch or plain
// fallback in the production CLI. Real DPAPI has its own Windows round-trip test.
import { DpapiProtector } from '../../src/secrets/protector.ts'
DpapiProtector.prototype.protect = async function (value) { return Buffer.from(value).toString('base64') }
DpapiProtector.prototype.unprotect = async function (value) { return Buffer.from(value, 'base64').toString('utf8') }
