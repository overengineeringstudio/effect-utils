"""Pure audit correlation regression tests; no host, log stream or protected APIs."""
import json
import unittest

from evidence import Tripwire, correlate_audit, parse


class AuditCorrelationTests(unittest.TestCase):
    def setUp(self):
        self.begin = json.loads('{"auditId":"request-1","phase":"begin","op":"status"}')
        self.complete = json.loads('{"auditId":"request-1","phase":"complete","op":"status","status":"ok"}')

    def test_pairs_status_intent_and_completion(self):
        unrelated = {'auditId': 'request-2', 'phase': 'begin'}
        self.assertEqual(correlate_audit([self.begin, unrelated, self.complete], 'request-1'),
                         [self.begin, self.complete])

    def test_requires_both_phases(self):
        for rows in ([], [self.begin], [self.complete]):
            with self.subTest(rows=rows), self.assertRaises(RuntimeError):
                correlate_audit(rows, 'request-1')

    def test_rejects_duplicate_or_reversed_phases(self):
        for rows in ([self.begin, self.begin, self.complete],
                     [self.begin, self.complete, self.complete],
                     [self.complete, self.begin],
                     [self.begin, {'auditId': 'request-1', 'phase': 'unknown'}, self.complete]):
            with self.subTest(rows=rows), self.assertRaises(RuntimeError):
                correlate_audit(rows, 'request-1')

    def test_requires_nonempty_response_audit_id(self):
        for audit_id in (None, '', 1):
            with self.subTest(audit_id=audit_id), self.assertRaises(RuntimeError):
                correlate_audit([self.begin, self.complete], audit_id)


HOST_ID = 'dev.overeng.permissions-host.experiment'
HOST_PATH = '/Library/Example/Permissions Host.app/Contents/MacOS/permissions-host'
CLIENT_PATH = '/nix/store/example-native/client'


class TripwireTests(unittest.TestCase):
    def setUp(self):
        self.tripwire = Tripwire({HOST_ID, HOST_PATH, CLIENT_PATH})

    def observe(self, message, allowed=()):
        return self.tripwire.observe(parse({'eventMessage': message}), set(allowed))

    def context(self, request='636.3097', preflight='no', allowed=()):
        return self.observe(
            f'AUTHREQ_CTX: msgID={request}, function=<private>, '
            f'service=kTCCServiceMicrophone, preflight={preflight}, query=1, '
            'client_dict=(null), daemon_dict=<private>', allowed)

    def attribution(self, processes, request='636.3097', allowed=()):
        blocks = ', '.join(
            f'{role}={{TCCDProcess: identifier={identifier}, pid=123, auid=501, '
            f'euid=501, binary_path={path}}}'
            for role, identifier, path in processes)
        return self.observe(f'AUTHREQ_ATTRIBUTION: msgID={request}, attribution={{{blocks}, }},',
                            allowed)

    def test_preserves_all_process_identities(self):
        message = ('AUTHREQ_ATTRIBUTION: msgID=1.2, attribution={'
                   'accessing={TCCDProcess: identifier=dev.example.accessing, pid=1, '
                   'binary_path=/Applications/Example App.app/Contents/MacOS/app}, '
                   f'requesting={{TCCDProcess: identifier={HOST_ID}, pid=2, binary_path={HOST_PATH}}}, '
                   'responsible={TCCDProcess: identifier=dev.example.responsible, pid=3, '
                   'binary_path=/usr/bin/example}, },')
        event = parse({'eventMessage': message})
        self.assertEqual(event['attribution'], [
            {'role': 'accessing', 'identifier': 'dev.example.accessing',
             'binary_path': '/Applications/Example App.app/Contents/MacOS/app'},
            {'role': 'requesting', 'identifier': HOST_ID, 'binary_path': HOST_PATH},
            {'role': 'responsible', 'identifier': 'dev.example.responsible',
             'binary_path': '/usr/bin/example'}])

    def test_foreign_microphone_request_is_recorded_once_and_ignored(self):
        self.assertTrue(self.context()['pending'])
        state = self.attribution([
            ('accessing', 'dev.example.browser', '/Applications/Example.app/Contents/MacOS/browser'),
            ('requesting', 'dev.example.node', '/nix/store/example-node/bin/node')])
        self.assertEqual(state['attribution'], 'foreign')
        self.assertTrue(state['recordForeign'])
        state = self.observe('AUTHREQ_RESULT: msgID=636.3097, authValue=0, authReason=5,')
        self.assertEqual(state['attribution'], 'foreign')
        self.assertFalse(state['recordForeign'])

    def test_each_role_and_identity_can_attribute_host(self):
        for role in ('accessing', 'requesting', 'responsible'):
            for identifier, path in ((HOST_ID, '/usr/bin/example'),
                                     ('dev.example.other', HOST_PATH),
                                     ('dev.example.other', CLIENT_PATH)):
                with self.subTest(role=role, identifier=identifier, path=path):
                    self.setUp()
                    self.context()
                    others = [('accessing', 'dev.example.foreign', '/usr/bin/foreign')]
                    with self.assertRaisesRegex(RuntimeError, 'unannounced non-preflight AUTHREQ: kTCCServiceMicrophone'):
                        self.attribution([(role, identifier, path), *others])

    def test_result_without_attribution_aborts(self):
        self.context()
        with self.assertRaisesRegex(RuntimeError, 'ambiguous attribution'):
            self.observe('AUTHREQ_RESULT: msgID=636.3097, authValue=0, authReason=5,')

    def test_redacted_attribution_stays_ambiguous(self):
        self.context()
        self.observe('AUTHREQ_ATTRIBUTION: msgID=636.3097, attribution=<private>')
        with self.assertRaisesRegex(RuntimeError, 'ambiguous attribution'):
            self.observe('AUTHREQ_RESULT: msgID=636.3097, authValue=0,')

    def test_unannounced_prompting_aborts_even_for_foreign_request(self):
        self.context()
        self.attribution([('accessing', 'dev.example.foreign', '/usr/bin/foreign')])
        with self.assertRaisesRegex(RuntimeError, 'unannounced AUTHREQ prompting'):
            self.observe('AUTHREQ_PROMPTING: msgID=636.3097,')

    def test_subject_only_host_or_client_path_aborts(self):
        for path in (HOST_PATH, CLIENT_PATH):
            with self.subTest(path=path):
                self.setUp()
                self.context()
                with self.assertRaisesRegex(RuntimeError, 'unannounced non-preflight AUTHREQ'):
                    self.observe(f'AUTHREQ_SUBJECT: msgID=636.3097, subject={path},')

    def test_foreign_attribution_does_not_hide_host_subject(self):
        self.context()
        self.attribution([('accessing', 'dev.example.foreign', '/usr/bin/foreign')])
        with self.assertRaisesRegex(RuntimeError, 'unannounced non-preflight AUTHREQ'):
            self.observe(f'AUTHREQ_SUBJECT: msgID=636.3097, subject={HOST_PATH},')

    def test_interleaved_and_attribution_first_requests(self):
        self.attribution([('responsible', HOST_ID, HOST_PATH)], request='1.2')
        self.context()
        self.attribution([('accessing', 'dev.example.foreign', '/usr/bin/foreign')])
        self.observe('AUTHREQ_RESULT: msgID=636.3097, authValue=0,')
        with self.assertRaisesRegex(RuntimeError, 'unannounced non-preflight AUTHREQ'):
            self.context(request='1.2')

    def test_preflight_and_allowed_service_do_not_abort(self):
        for preflight, allowed in (('yes', ()), ('no', ('kTCCServiceMicrophone',))):
            with self.subTest(preflight=preflight, allowed=allowed):
                self.setUp()
                self.context(preflight=preflight, allowed=allowed)
                self.attribution([('accessing', HOST_ID, HOST_PATH)], allowed=allowed)
                self.observe('AUTHREQ_RESULT: msgID=636.3097, authValue=0,', allowed)

    def test_fda_silent_non_preflight_but_not_prompting_is_allowed(self):
        for attribution_first in (False, True):
            with self.subTest(attribution_first=attribution_first):
                self.setUp()
                processes = [('accessing', HOST_ID, HOST_PATH),
                             ('requesting', 'com.apple.sandboxd', '/usr/libexec/sandboxd')]
                if attribution_first:
                    self.attribution(processes)
                state = self.observe('AUTHREQ_CTX: msgID=636.3097, '
                                     'service=kTCCServiceSystemPolicyAllFiles, preflight=no,')
                if not attribution_first:
                    state = self.attribution(processes)
                self.assertFalse(state['pending'])
                self.assertTrue(state['silentNonPreflight'])
                state = self.observe('AUTHREQ_RESULT: msgID=636.3097, authValue=0,')
                self.assertTrue(state['silentNonPreflight'])
                with self.assertRaisesRegex(RuntimeError, 'unannounced AUTHREQ prompting'):
                    self.observe('AUTHREQ_PROMPTING: msgID=636.3097,')
        self.setUp()
        self.context()
        with self.assertRaisesRegex(RuntimeError, 'unannounced non-preflight AUTHREQ: kTCCServiceMicrophone'):
            self.attribution([('accessing', HOST_ID, HOST_PATH)])

    def test_unknown_or_uncorrelatable_records_still_abort(self):
        for message in ('AUTHREQ_CTX: service=kTCCServiceMicrophone, preflight=no',
                        'AUTHREQ_UNKNOWN: msgID=1.2',
                        'AUTHREQ_CTX: msgID=1.2, service=kTCCServiceMicrophone'):
            with self.subTest(message=message), self.assertRaises(RuntimeError):
                self.observe(message)


if __name__ == '__main__':
    unittest.main()
