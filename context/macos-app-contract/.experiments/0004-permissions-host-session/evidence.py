#!/usr/bin/env python3
"""Parse actual unified-log JSONL; never infer a grant from a missing log row."""
import argparse
import json
import re
import sys

FIELD = re.compile(r'\b(msgID|service|authValue|preflight)\s*[:=]\s*(?:"([^"]*)"|([^,;\s}]+))')
KIND = re.compile(r'\bAUTHREQ_([A-Z_]+)\b')
PROCESS = re.compile(r'\b(accessing|requesting|responsible)\s*=\s*\{TCCDProcess:\s*([^}]+)\}')
IDENTITY = re.compile(r'\b(identifier|binary_path)\s*=\s*(?:"([^"]*)"|([^,}]+))')
SUBJECT = re.compile(r'\bsubject\s*=\s*(?:"([^"]*)"|([^,]+))')
# TCC has no consent UI for FDA; the GUI watcher still independently aborts
# on any SecurityAgent/UserNotificationCenter window.
NON_PROMPTING_SERVICES = {'kTCCServiceSystemPolicyAllFiles'}


def parse(row):
    message = row.get('eventMessage', '')
    match = KIND.search(message)
    if not match:
        return None
    fields = {m[1]: m[2] if m[2] is not None else m[3] for m in FIELD.finditer(message)}
    event = {'kind': match[1], 'timestamp': row.get('timestamp'), 'fields': fields,
             'message': message, 'processID': row.get('processID')}
    if event['kind'] == 'ATTRIBUTION':
        event['attribution'] = [
            {'role': process[1], **{
                value[1]: (value[2] if value[2] is not None else value[3]).strip()
                for value in IDENTITY.finditer(process[2])
            }} for process in PROCESS.finditer(message)
        ]
    if event['kind'] == 'SUBJECT':
        subject = SUBJECT.search(message)
        if subject:
            fields['subject'] = (subject[1] if subject[1] is not None else subject[2]).strip()
    return event


def correlate_audit(rows, audit_id):
    """Require one persisted intent followed by one completion for this request."""
    if not isinstance(audit_id, str) or not audit_id:
        raise RuntimeError('host audit correlation missing auditId')
    matching = [row for row in rows if row.get('auditId') == audit_id]
    if [row.get('phase') for row in matching] != ['begin', 'complete']:
        raise RuntimeError('host audit correlation requires one begin and one complete')
    return matching


class Tripwire:
    """Correlate interleaved AUTHREQ lines by msgID; unknowns deny, never allow."""
    def __init__(self, host_identities):
        self.host_identities = frozenset(host_identities)
        if not self.host_identities:
            raise ValueError('experiment host identities required')
        self.requests = {}

    def observe(self, event, allowed_services):
        fields = event['fields']
        request_id = fields.get('msgID')
        if request_id is None:
            raise RuntimeError('AUTHREQ without msgID: cannot correlate safely')
        state = self.requests.setdefault(request_id, {})
        state.update(fields)
        if event['kind'] not in ('CTX', 'SUBJECT', 'ATTRIBUTION', 'RESULT', 'PROMPTING'):
            raise RuntimeError('unrecognized AUTHREQ record: ' + event['kind'])
        if event['kind'] == 'PROMPTING' and state.get('service') not in allowed_services:
            raise RuntimeError('unannounced AUTHREQ prompting')
        if event['kind'] == 'ATTRIBUTION':
            identities = [process.get(key) for process in event['attribution']
                          for key in ('identifier', 'binary_path')]
        elif event['kind'] == 'SUBJECT':
            identities = [fields.get('subject')]
        else:
            identities = []
        identities = {value for value in identities if value and value != '<private>'}
        if identities:
            state['attributionSeen'] = True
            if identities & self.host_identities:
                state['attribution'] = 'host'
            elif state.get('attribution') != 'host':
                state['attribution'] = 'foreign'
        if event['kind'] == 'CTX':
            if state.get('preflight') not in ('0', '1', 'true', 'false', 'YES', 'NO', 'yes', 'no'):
                raise RuntimeError('AUTHREQ preflight field unavailable')
            state['pending'] = (state['preflight'] in ('0', 'false', 'NO', 'no')
                                and state.get('service') not in allowed_services)
        if (state.get('attribution') == 'host'
                and state.get('service') in NON_PROMPTING_SERVICES
                and state.get('preflight') in ('0', 'false', 'NO', 'no')):
            state['pending'] = False
            state['silentNonPreflight'] = True
        if state.get('pending') and state.get('attribution') == 'host':
            raise RuntimeError('unannounced non-preflight AUTHREQ: ' + str(state.get('service')))
        if event['kind'] == 'RESULT' and state.get('pending') and not state.get('attributionSeen'):
            raise RuntimeError('unannounced non-preflight AUTHREQ: ambiguous attribution')
        record_foreign = state.get('attribution') == 'foreign' and not state.get('foreignRecorded')
        if record_foreign:
            state['foreignRecorded'] = True
        return {**state, 'recordForeign': record_foreign}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('input', nargs='?', default='-')
    args = parser.parse_args()
    source = sys.stdin if args.input == '-' else open(args.input, encoding='utf-8')
    try:
        for number, line in enumerate(source, 1):
            if not line.strip():
                continue
            row = json.loads(line)
            event = parse(row)
            if event:
                print(json.dumps({'line': number, **event}, sort_keys=True))
    finally:
        if source is not sys.stdin:
            source.close()


if __name__ == '__main__':
    main()
