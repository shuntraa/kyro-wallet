//! Official BIP39 vectors from trezor/python-mnemonic `vectors.json` (passphrase "TREZOR").

use wallet_core::Mnemonic;

const VECTORS: &[(&str, &str, &str)] = &[
    ("00000000000000000000000000000000",
     "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
     "c55257c360c07c72029aebc1b53c05ed0362ada38ead3e3e9efa3708e53495531f09a6987599d18264c1e1c92f2cf141630c7a3c4ab7c81b2f001698e7463b04"),
    ("7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f",
     "legal winner thank year wave sausage worth useful legal winner thank yellow",
     "2e8905819b8723fe2c1d161860e5ee1830318dbf49a83bd451cfb8440c28bd6fa457fe1296106559a3c80937a1c1069be3a3a5bd381ee6260e8d9739fce1f607"),
    ("80808080808080808080808080808080",
     "letter advice cage absurd amount doctor acoustic avoid letter advice cage above",
     "d71de856f81a8acc65e6fc851a38d4d7ec216fd0796d0a6827a3ad6ed5511a30fa280f12eb2e47ed2ac03b5c462a0358d18d69fe4f985ec81778c1b370b652a8"),
    ("ffffffffffffffffffffffffffffffff",
     "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong",
     "ac27495480225222079d7be181583751e86f571027b0497b5b5d11218e0a8a13332572917f0f8e5a589620c6f15b11c61dee327651a14c34e18231052e48c069"),
    ("0000000000000000000000000000000000000000000000000000000000000000",
     "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art",
     "bda85446c68413707090a52022edd26a1c9462295029f2e60cd7c4f2bbd3097170af7a4d73245cafa9c3cca8d561a7c3de6f5d4a10be8ed2a5e608d68f92fcc8"),
    ("7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f",
     "legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth title",
     "bc09fca1804f7e69da93c2f2028eb238c227f2e9dda30cd63699232578480a4021b146ad717fbb7e451ce9eb835f43620bf5c514db0f8add49f5d121449d3e87"),
    ("9e885d952ad362caeb4efe34a8e91bd2",
     "ozone drill grab fiber curtain grace pudding thank cruise elder eight picnic",
     "274ddc525802f7c828d8ef7ddbcdc5304e87ac3535913611fbbfa986d0c9e5476c91689f9c8a54fd55bd38606aa6a8595ad213d4c9c9f9aca3fb217069a41028"),
    ("6d9be1ee6ebd27a258115aad99b7317b9c8d28b6d76431c3",
     "horn tenant knee talent sponsor spell gate clip pulse soap slush warm silver nephew swap uncle crack brave",
     "fd579828af3da1d32544ce4db5c73d53fc8acc4ddb1e3b251a31179cdb71e853c56d2fcb11aed39898ce6c34b10b5382772db8796e52837b54468aeb312cfc3d"),
    ("9f6a2878b2520799a44ef18bc7df394e7061a224d2c33cd015b157d746869863",
     "panda eyebrow bullet gorilla call smoke muffin taste mesh discover soft ostrich alcohol speed nation flash devote level hobby quick inner drive ghost inside",
     "72be8e052fc4919d2adf28d5306b5474b0069df35b02303de8c1729c9538dbb6fc2d731d5f832193cd9fb6aeecbc469594a70e3dd50811b5067f3b88b28c3e8d"),
    ("23db8160a31d3e0dca3688ed941adbf3",
     "cat swing flag economy stadium alone churn speed unique patch report train",
     "deb5f45449e615feff5640f2e49f933ff51895de3b4381832b3139941c57b59205a42480c52175b6efcffaa58a2503887c1e8b363a707256bdd2b587b46541f5"),
    ("066dca1a2bb7e8a1db2832148ce9933eea0f3ac9548d793112d9a95c9407efad",
     "all hour make first leader extend hole alien behind guard gospel lava path output census museum junior mass reopen famous sing advance salt reform",
     "26e975ec644423f4a4c4f4215ef09b4bd7ef924e85d1d17c4cf3f136c2863cf6df0a475045652c57eb5fb41513ca2a2d67722b77e954b4b3fc11f7590449191d"),
    ("f585c11aec520db57dd353c69554b21a89b20fb0650966fa0a9d6f74fd989d8f",
     "void come effort suffer camp survey warrior heavy shoot primary clutch crush open amazing screen patrol group space point ten exist slush involve unfold",
     "01f5bced59dec48e362f2c45b5de68b9fd6c92c6634f44d6d40aab69056506f0e35524a518034ddc1192e1dacd32c1ed3eaa3c3b131c88ed8e7e54c49a5d0998"),
];

#[test]
fn trezor_vectors_entropy_mnemonic_seed() {
    for (entropy_hex, phrase, seed_hex) in VECTORS {
        // entropy -> mnemonic (via the same audited bip39 crate the core wraps)
        let entropy = hex::decode(entropy_hex).unwrap();
        let from_entropy = bip39::Mnemonic::from_entropy(&entropy).unwrap();
        assert_eq!(from_entropy.to_string(), *phrase, "entropy {entropy_hex}");

        let m = Mnemonic::parse(phrase).unwrap();
        assert_eq!(m.words().join(" "), *phrase);
        assert_eq!(m.word_count(), phrase.split(' ').count());
        assert_eq!(
            hex::encode(&m.to_seed("TREZOR")[..]),
            *seed_hex,
            "seed for {phrase}"
        );
    }
}

#[test]
fn includes_12_and_24_word_vectors() {
    let counts: Vec<usize> = VECTORS.iter().map(|v| v.1.split(' ').count()).collect();
    assert!(counts.contains(&12));
    assert!(counts.contains(&18));
    assert!(counts.contains(&24));
}

#[test]
fn words_to_vec() {
    let m = Mnemonic::parse(VECTORS[0].1).unwrap();
    let v: Vec<String> = m.words().to_vec();
    assert_eq!(v.len(), 12);
    assert_eq!(v[11], "about");
}
