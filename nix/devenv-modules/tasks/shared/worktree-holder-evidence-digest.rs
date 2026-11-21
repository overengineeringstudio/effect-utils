//! In-process SHA-256, independent of process execution and Linux census code.
use std::io;
use std::time::Instant;

/// FIPS 180-4 SHA-256. Hashing in-process is important: no decoder child may
/// appear after the final all-task census closure merely to hash its receipt.
pub fn digest(input: Vec<u8>, deadline: Instant) -> io::Result<String> {
    use std::fmt::Write;
    const K: [u32;64] = [
        0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
        0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
        0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
        0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
        0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
        0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
        0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
        0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
    ];
    let mut state = [0x6a09e667_u32,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
    fn compress(state: &mut [u32;8], block: &[u8]) {
        let mut words=[0_u32;64];
        for (i,chunk) in block.chunks_exact(4).enumerate() {
            words[i]=u32::from_be_bytes([chunk[0],chunk[1],chunk[2],chunk[3]]);
        }
        for i in 16..64 {
            let x=words[i-15]; let y=words[i-2];
            let s0=x.rotate_right(7)^x.rotate_right(18)^(x>>3);
            let s1=y.rotate_right(17)^y.rotate_right(19)^(y>>10);
            words[i]=words[i-16].wrapping_add(s0).wrapping_add(words[i-7]).wrapping_add(s1);
        }
        let [mut a,mut b,mut c,mut d,mut e,mut f,mut g,mut h]=*state;
        for i in 0..64 {
            let s1=e.rotate_right(6)^e.rotate_right(11)^e.rotate_right(25);
            let ch=(e&f)^(!e&g);
            let t1=h.wrapping_add(s1).wrapping_add(ch).wrapping_add(K[i]).wrapping_add(words[i]);
            let s0=a.rotate_right(2)^a.rotate_right(13)^a.rotate_right(22);
            let maj=(a&b)^(a&c)^(b&c); let t2=s0.wrapping_add(maj);
            h=g; g=f; f=e; e=d.wrapping_add(t1); d=c; c=b; b=a; a=t1.wrapping_add(t2);
        }
        for (word,value) in state.iter_mut().zip([a,b,c,d,e,f,g,h]) { *word=word.wrapping_add(value); }
    }
    // No heap padding copy. The final one or two blocks fit in fixed stack
    // storage; every full block rechecks the capture's interruptible deadline.
    let mut blocks=input.chunks_exact(64);
    for block in &mut blocks {
        if Instant::now()>=deadline { return Err(io::Error::new(io::ErrorKind::TimedOut,"digest deadline")); }
        compress(&mut state,block);
    }
    let tail=blocks.remainder(); let mut final_blocks=[0_u8;128];
    final_blocks[..tail.len()].copy_from_slice(tail); final_blocks[tail.len()]=0x80;
    let padded=if tail.len()<56 {64} else {128};
    let bits=(input.len() as u64).checked_mul(8).ok_or_else(||io::Error::other("digest length overflow"))?;
    final_blocks[padded-8..padded].copy_from_slice(&bits.to_be_bytes());
    for block in final_blocks[..padded].chunks_exact(64) { compress(&mut state,block); }
    if Instant::now()>=deadline { return Err(io::Error::new(io::ErrorKind::TimedOut,"digest deadline")); }
    let mut output=String::with_capacity(64);
    for word in state { write!(output,"{word:08x}").expect("String write"); }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn sha256_standard_vectors_and_padding_boundary() {
        let deadline=Instant::now()+Duration::from_secs(1);
        for (input,expected) in [
            ("","e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"),
            ("abc","ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"),
            ("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq","248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"),
        ] { assert_eq!(digest(input.as_bytes().to_vec(),deadline).unwrap(),expected); }
        assert!(digest(Vec::new(),Instant::now()).is_err());
    }

}
