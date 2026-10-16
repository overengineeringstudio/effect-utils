#!/usr/bin/env python3
"""Parse actual unified-log JSONL; never infer a grant from a missing log row."""
import argparse
import json
import re
import sys

FIELD = re.compile(r'\b(msgID|service|authValue|preflight|identifier|subject|client|responsible|accessing)\s*[:=]\s*(?:"([^"]*)"|([^,;\s}]+))')
KIND = re.compile(r'\bAUTHREQ_([A-Z_]+)\b')


def parse(row):
    message = row.get('eventMessage', '')
    match = KIND.search(message)
    if not match:
        return None
    fields = {m[1]: m[2] if m[2] is not None else m[3] for m in FIELD.finditer(message)}
    return {'kind': match[1], 'timestamp': row.get('timestamp'), 'fields': fields,
            'message': message, 'processID': row.get('processID')}


class Tripwire:
    """Correlate interleaved AUTHREQ lines by msgID; unknowns deny, never allow."""
    def __init__(self):
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
        if event['kind'] == 'CTX':
            if state.get('preflight') not in ('0', '1', 'true', 'false', 'YES', 'NO', 'yes', 'no'):
                raise RuntimeError('AUTHREQ preflight field unavailable')
            if state['preflight'] in ('0', 'false', 'NO', 'no') and state.get('service') not in allowed_services:
                raise RuntimeError('unannounced non-preflight AUTHREQ: ' + str(state.get('service')))
        return dict(state)


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
