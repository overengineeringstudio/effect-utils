#!/usr/bin/env python3
"""Repeat identical-result AC update and skip-cache Execute in an approved workspace.
Requires grpcio. Credential files, digest and endpoints are caller-owned inputs.
Only status/count/timing is emitted; never response bodies or error details.
"""
import json
import os
from pathlib import Path
import time
import grpc


def varint(value):
    result = bytearray()
    while value > 127:
        result.append((value & 127) | 128)
        value >>= 7
    result.append(value)
    return bytes(result)


def field(number, payload):
    return varint((number << 3) | 2) + varint(len(payload)) + payload


ro = json.loads(Path(os.environ['NS_RO_FILE']).read_text())
rw = json.loads(Path(os.environ['NS_RW_FILE']).read_text())
digest = field(1, os.environ['ACTION_HASH'].encode('ascii')) + b'\x10' + varint(int(os.environ['ACTION_SIZE']))
get_request = field(2, digest)
execute_request = b'\x18\x01' + field(6, digest)  # skip_cache_lookup=true
base = '/build.bazel.remote.execution.v2.'


def request(label, endpoint, method, payload, stream=False):
    start = time.monotonic()
    with grpc.secure_channel(endpoint.removeprefix('grpcs://'), grpc.ssl_channel_credentials()) as channel:
        try:
            rpc = channel.unary_stream(base + method) if stream else channel.unary_unary(base + method)
            result = rpc(payload, metadata=[('x-nsc-ingress-auth', 'Bearer ' + ro['ingress_auth_token'])], timeout=30)
            count = sum(1 for _ in result) if stream else None
            print(json.dumps({'label': label, 'status': 'OK', 'messages': count, 'seconds': round(time.monotonic() - start, 3)}))
            return None if stream else result
        except grpc.RpcError as error:
            print(json.dumps({'label': label, 'status': error.code().name, 'seconds': round(time.monotonic() - start, 3)}))
            return None


result = request('RO GetActionResult', ro['storage_endpoint'], 'ActionCache/GetActionResult', get_request)
if result is not None:
    update = get_request + field(3, result)
    request('RO identical UpdateActionResult', ro['storage_endpoint'], 'ActionCache/UpdateActionResult', update)
    request('RO bearer RW identical UpdateActionResult', rw['storage_endpoint'], 'ActionCache/UpdateActionResult', update)
request('RO endpoint Execute', ro['storage_endpoint'], 'Execution/Execute', execute_request, True)
request('RO bearer scheduler Execute skip-cache', rw['scheduler_endpoint'], 'Execution/Execute', execute_request, True)
