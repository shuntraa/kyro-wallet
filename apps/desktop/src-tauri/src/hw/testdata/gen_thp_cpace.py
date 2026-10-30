# Regenerates thp_cpace_trezorlib.json with python-trezorlib's own CPace (no Kyro code).
# Usage: copy trezor-firmware/python/src/trezorlib/thp/curve25519.py to DIR/ref_curve25519.py and
# thp/cpace.py to DIR/ref_cpace.py (replace "from . import curve25519" by
# "import ref_curve25519 as curve25519"), then: python -I gen_thp_cpace.py DIR out.json
import sys, json, random, hashlib
sys.path.insert(0, sys.argv[1])
import ref_cpace, ref_curve25519 as c
rng = random.Random(20261030)
out = []
for _ in range(200):
    code = "%06d" % rng.randrange(1_000_000)
    hh = rng.randbytes(32); k = rng.randbytes(32); t = rng.randbytes(32)
    dev = ref_cpace.cpace(prs=code.encode(), ci=hh, b_pubkey=bytes([9]+[0]*31), _a_privkey=t)
    host = ref_cpace.cpace(prs=code.encode(), ci=hh, b_pubkey=dev.a_pubkey, _a_privkey=k)
    tag = hashlib.sha256(host.shared_secret).digest()
    assert hashlib.sha256(c.multiply(t, host.a_pubkey)).digest() == tag
    out.append([code, hh.hex(), k.hex(), t.hex(), dev.a_pubkey.hex(), host.a_pubkey.hex(), tag.hex()])
json.dump(out, open(sys.argv[2], "w"), separators=(",", ":"))
print(len(out), "vectors")
