/** Shared cross-language wire vectors. Test-only RFC 8032 seed; never an enrollment key. */
export const canonicalVectors = [
  {
    value: { z: 'é', a: 'e\u0301', '\ud83d\ude00': 'quote"\n', '\ufffd': 0 },
    expected: '{"a":"é","z":"é","😀":"quote\\\"\\n","�":0}',
  },
  {
    value: { until: 1795039200000, optionId: 'allow-once', items: [true, false, null, -0] },
    expected: '{"items":[true,false,null,0],"optionId":"allow-once","until":1795039200000}',
  },
] as const
export const testEd25519Seed = '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60'
export const testEd25519PublicKey =
  'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a'
export const decisionVector = {
  payload: {
    epoch: 'scg-experiment-v1',
    kind: 'decision',
    executionId: '00000000-0000-4000-8000-000000000001',
    pendingDigest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
    optionId: 'allow-once',
    surfaceId: 'test',
    principalId: 'owner',
    decidedAt: 1795039200000,
  },
  keyId: 'test-key',
  signature:
    'PdahgWoT8i63ApslGjVyWIGG7GZIX0gmrMtW6MLbaZQUgg0JZsOUrO9n9mEc1FHcK+9p7PRVx5EN5f0JSlmOBQ==',
  digest: 'sha256:41e02cbe78925608f0b33ddeb6dd15e15d54d6b41557d2bd37245c01912b5c2a',
  signingText:
    '{"algorithm":"Ed25519","domain":"scg/decision/v1","keyId":"test-key","payload":{"decidedAt":1795039200000,"epoch":"scg-experiment-v1","executionId":"00000000-0000-4000-8000-000000000001","kind":"decision","optionId":"allow-once","pendingDigest":"sha256:0000000000000000000000000000000000000000000000000000000000000000","principalId":"owner","surfaceId":"test"}}',
} as const
