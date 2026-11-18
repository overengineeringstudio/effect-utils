/** Shared cross-language wire vectors. Test-only RFC 8032 seed; never an enrollment key. */
export const canonicalVectors = [
  { value: { z: 'é', a: 'e\u0301', '\ud83d\ude00': 'quote"\n', '\ufffd': 0 }, expected: '{"a":"é","z":"é","😀":"quote\\\"\\n","�":0}' },
  { value: { until: 1795039200000, optionId: 'allow-once', items: [true, false, null, -0] }, expected: '{"items":[true,false,null,0],"optionId":"allow-once","until":1795039200000}' },
] as const
export const testEd25519Seed = '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60'
export const testEd25519PublicKey = 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a'
