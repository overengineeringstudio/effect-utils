"""Pure audit correlation regression tests; no host, log stream or protected APIs."""
import json
import unittest

from evidence import correlate_audit


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


if __name__ == '__main__':
    unittest.main()
