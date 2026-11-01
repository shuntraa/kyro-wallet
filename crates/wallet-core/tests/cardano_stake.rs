//! Cardano staking (Conway certificates and reward withdrawals).
//!
//! Vectors: Trezor firmware fixtures `common/tests/fixtures/cardano/sign_tx.json`
//! (trezor-firmware commit f158cb46, mnemonic `all × 12`, input `m/1852'/1815'/0'/0/0`, stake key
//! `m/1852'/1815'/0'/2/0`, one 1-lovelace output, fee 42, ttl 10): transaction hashes and the
//! **Ed25519 signatures of both witnesses**, which Kyro must reproduce byte for byte. Fixtures with
//! certificates Kyro refuses (legacy registration 0 / deregistration 1) are rebuilt by hand, their
//! hash checked against Trezor's, and then shown to be refused.

use wallet_core::{
    cardano_address_bytes, cardano_blake2b224, cardano_blake2b256, cardano_cip20_aux,
    cardano_decode_stake_tx, cardano_decode_tx, cardano_drep_id, cardano_drep_parse,
    cardano_pool_bech32, cardano_pool_id, cardano_reward_address_bytes, cardano_sign_stake,
    cardano_signed_witnesses, cardano_stake_address, cardano_stake_public_key, cardano_unsigned_tx,
    CardanoBody, CardanoCert, CardanoCertView, CardanoContext, CardanoDrep, CardanoDrepView,
    CardanoInput, CardanoOutput, CardanoRoot, Mnemonic, Network,
};

const ALL: &str = "all all all all all all all all all all all all";
const TZ_PREV: &str = "3b40265111d8bb3c3c608d95b3a0bf83461ace32d79336579a1939b3aad1c0b7";
const TZ_DEST: &str = "addr1q84sh2j72ux0l03fxndjnhctdg7hcppsaejafsa84vh7lwgmcs5wgus8qt4atk45lvt4xfxpjtwfhdmvchdf2m3u3hlsd5tq5r";
const PAY_PK: &str = "5d010cf16fdeff40955633d6c565f3844a288a24967cf6b76acbeb271b4f13c1";
const STAKE_PK: &str = "bc65be1b0b9d7531778a1317c2aa6de936963c3f9ac7d5ee9e9eda25e0c97c5e";
/// Stake key `m/1852'/1815'/0'/2/1` (Trezor's "non-zero address index" fixtures): not ours.
const STAKE_PK_2_1: &str = "3963e13782d53ac894789a145db59830231d11f84d2df25c7f38db320de20cdc";
const POOL: &str = "f61c42cbf7c8c53af3f520508212ad3e72f674f957fe23ff0acb4973";
const DREP_HASH: &str = "29fb5fd4aa8cadd6705acc8263cee0fc62edca5ac38db593fec2f9fd";
const DEPOSIT: u64 = 2_000_000;

fn root() -> CardanoRoot {
    CardanoRoot::from_mnemonic(&Mnemonic::parse(ALL).unwrap(), "")
}

fn h28(s: &str) -> [u8; 28] {
    hex::decode(s).unwrap().try_into().unwrap()
}

fn stake_hash() -> [u8; 28] {
    cardano_blake2b224(&hex::decode(STAKE_PK).unwrap())
}

fn body(certs: Vec<CardanoCert>, withdrawals: Vec<(Vec<u8>, u64)>, tagged: bool) -> CardanoBody {
    CardanoBody {
        inputs: vec![CardanoInput {
            tx_hash: hex::decode(TZ_PREV).unwrap().try_into().unwrap(),
            index: 0,
        }],
        tagged_sets: tagged,
        outputs: vec![CardanoOutput {
            address: cardano_address_bytes(TZ_DEST, Network::Mainnet).unwrap(),
            coin: 1,
            assets: vec![],
            map_form: false,
        }],
        fee: 42,
        ttl: Some(10),
        certs,
        withdrawals,
        aux_hash: None,
        validity_start: None,
    }
}

/// Trezor pays 1 lovelace: the min-UTxO rule is disabled (coinsPerUTxOByte = 0) to reproduce it.
/// Trezor's single output plays our own address (a staking transaction pays only us).
fn ctx() -> CardanoContext<'static> {
    CardanoContext {
        net: Network::Mainnet,
        own: Box::leak(vec![TZ_DEST.to_string()].into_boxed_slice()),
        verified_tokens: &[],
        coins_per_byte: 0,
    }
}

/// Body hash, then both signatures (payment, stake), identical to Trezor's.
fn check(
    b: CardanoBody,
    tx_hash: &str,
    pay_sig: &str,
    stake_sig: &str,
) -> wallet_core::CardanoStakeSummary {
    assert_eq!(hex::encode(b.tx_id()), tx_hash);
    let unsigned = hex::encode(cardano_unsigned_tx(&b, None).unwrap());
    let (signed, id, s) = cardano_sign_stake(&root(), 0, 0, 0, &unsigned, &ctx(), DEPOSIT).unwrap();
    assert_eq!(id, tx_hash);
    assert_eq!(s.tx.tx_id, tx_hash);
    assert!(
        signed.contains(&format!("5820{PAY_PK}5840{pay_sig}")),
        "payment witness"
    );
    assert!(
        signed.contains(&format!("5820{STAKE_PK}5840{stake_sig}")),
        "stake witness"
    );
    let (wid, keys) = cardano_signed_witnesses(&signed).unwrap();
    assert_eq!(wid, tx_hash);
    assert_eq!(
        keys.iter().map(hex::encode).collect::<Vec<_>>(),
        vec![PAY_PK.to_string(), STAKE_PK.to_string()]
    );
    // Same decode without signing.
    let stake_pk: [u8; 32] = hex::decode(STAKE_PK).unwrap().try_into().unwrap();
    assert_eq!(
        cardano_decode_stake_tx(&unsigned, &ctx(), &stake_pk, DEPOSIT).unwrap(),
        s
    );
    // The payment decoder never accepts a certificate or a withdrawal.
    let e = cardano_decode_tx(&unsigned, &ctx())
        .unwrap_err()
        .to_string();
    assert!(e.contains("Staking"), "{e}");
    s
}

#[test]
fn our_stake_key_is_trezors() {
    let r = root();
    assert_eq!(
        hex::encode(cardano_stake_public_key(&r, 0).unwrap()),
        STAKE_PK
    );
    assert_eq!(
        cardano_reward_address_bytes(Network::Mainnet, &stake_hash()),
        [vec![0xE1], stake_hash().to_vec()].concat()
    );
}

#[test]
fn trezor_conway_registration() {
    let reg = CardanoCert::StakeRegistration {
        stake: stake_hash(),
        deposit: DEPOSIT,
    };
    let s = check(
        body(vec![reg.clone()], vec![], false),
        "e200b2c91f3493a1f3b9cfc8b6c141f70181741025e53941e9d57d22b1470c5c",
        "79a357517a08c7256b0fab1e93a92a477386f4c2d72cea7bc68527c0133c32472305f010350665d72e8017bb6c2080b5742680ce7700bbddda561c917f294a07",
        "dca542910d0362fc22744e7a24732343db4e013495a7d9b47562886f09af8eb56ecaa105e20a9df3e4248fdab61dd91b6fb2a3bfc15d0d9a0442671c07e1ba02",
    );
    assert_eq!(
        s.certificates,
        vec![CardanoCertView::StakeRegistration {
            deposit: "2000000".into()
        }]
    );
    assert_eq!((s.deposit.as_str(), s.refund.as_str()), ("2000000", "0"));
    assert_eq!(
        s.stake_address,
        cardano_stake_address(
            Network::Mainnet,
            &hex::decode(STAKE_PK).unwrap().try_into().unwrap()
        )
        .unwrap()
    );
    // 258-tagged sets (inputs and certificates).
    check(
        body(vec![reg], vec![], true),
        "5e27f8fba938603411452a8cb373462fb64305539573b7a9edc9155be5cd6473",
        "13c136487d8048ab7bbb081a324aa6b999e0b3237f956503b5446a4c409ec1062091b82e9e5459dee7ab0ba67ed874692d788872c8bbdb5ad4a3975c465fea09",
        "f0674db7194d8e04d7df416af8ad9dcf1b1203ca4b78f14c1e394d47418c8f7e95fd41a8f01c43eeeb39df6264359c865a41621fc1e6b540819b25c7c4df5803",
    );
}

#[test]
fn trezor_conway_deregistration() {
    let s = check(
        body(
            vec![CardanoCert::StakeDeregistration {
                stake: stake_hash(),
                refund: DEPOSIT,
            }],
            vec![],
            false,
        ),
        "564ad55097101e1ca85629cffe839f43a19bf33aa1940c99a62eb8f14392eebb",
        "a0fa6630498f57249b305824ad4d32157653820e7d651332a58af70a80364df882ee8b0471e76dd7a335eea84a18c52b12c02508779d46b193bc418c22e8a00f",
        "5d282fcd2685ee47f3770f84b2badf4046e8e76bfdaa26f74e292ecd16bcf89fb330b99edff13bc9c81e8c6523864f69a3ac7cde29d5a648707724c5cb48730e",
    );
    assert_eq!(s.refund, "2000000");
}

#[test]
fn trezor_vote_delegations() {
    for (drep, hash, pay, stake) in [
        (
            CardanoDrep::Key(h28(DREP_HASH)),
            "1669062fd6efc4f11ed8ae9511a9c9f4454fa4f64e2043483f99d7c711236664",
            "b900968efd7cfed3666a63f11267bb4fdc08684788883b91cf690e37834263387b164d52c770d1bb91578ca0029a954c9ef787ab0d3b9f3f396dedf744baa80b",
            "d4fb5ebae0a061afa784df1ecceda5c06955a59ebc1ca4f7c2457f7ba27eacca756b8be9d84584f1b2ea23ce7b8420c73fc447398cf6caa725cb0d5c9b9f700e",
        ),
        (
            CardanoDrep::Script(h28(DREP_HASH)),
            "fccf753e4f96e20c880e5ea933041ed33509ec6c0dc1aee8b25a1fe3d562b7aa",
            "bde0242fee0de5b862d2f02847d789ebe10e8f82bf15837370f115c89c1b413f1b0fa5a470210127af92059c4d3ebff297d39e93143667d3823476f12f0f6f07",
            "cd8a2fca634c1aa2c88609042de7e4fce232bf233b1271612b5edc7b806e11ff44e6b6b15feb5b6e76b7e16a8d703e7653d860c00981edf6fe3b1e4cbeaba406",
        ),
        (
            CardanoDrep::AlwaysAbstain,
            "01d0f76fadc899087c5352befac56cbfdc2e868ac715fbfe00230bab3f7fa751",
            "52c57d9c0e06fc9883285db4eec1a1504e27726dc5afce943d6f54df22188f05c3eeee06d052375eceb55df83c314237b3718f07fccef6198bda8c20d794b102",
            "6de4940ff99738aaf3659ffeb8e4f6f01ff88ddb65c24028d75a847ca684d07af000e32eaa4c915c8031f6d928b2bcbe8c6f57e389299d3eafe213bd0ab1190c",
        ),
        (
            CardanoDrep::AlwaysNoConfidence,
            "567e9bd00787190f1ab51879dcf834002b76007130c526b2e4d1bf9a996f5ad0",
            "20e3f9ecc3a1b97cbda08cf610b2e72b45d0e0916af2be2ad472d4c8d2be4b13818497818961c8d27379754f0057b00fa286bce0d59f177f24eeee4e2b24940f",
            "898fb2cef0c4b954f22c4218fc9a188a5da340ddb5c6d5bba01c67520bbf537f5743814b6d40dd7f299ece7e39d7efb16a1cb597e8d421649a9483f631371703",
        ),
    ] {
        let s = check(
            body(
                vec![CardanoCert::VoteDelegation {
                    stake: stake_hash(),
                    drep,
                }],
                vec![],
                false,
            ),
            hash,
            pay,
            stake,
        );
        let CardanoCertView::VoteDelegation { drep: view } = &s.certificates[0] else {
            panic!("vote delegation")
        };
        assert_eq!(*view, CardanoDrepView::from(&drep));
    }
}

/// Raw body hex, for fixtures with certificates Kyro cannot encode (legacy 0 / 1).
fn body_hex(n_keys: u8, extra: &str) -> String {
    let addr = hex::encode(cardano_address_bytes(TZ_DEST, Network::Mainnet).unwrap());
    format!("a{n_keys}00818258 20{TZ_PREV}00 01818258 39{addr}01 02182a 030a {extra}")
        .replace(' ', "")
}

fn unsigned(body_hex: &str) -> String {
    format!("84{body_hex}a0f5f6")
}

#[test]
fn trezor_legacy_certificates_are_rebuilt_and_refused() {
    let me = hex::encode(stake_hash());
    let legacy_reg = format!("820082 00581c{me}");
    let legacy_dereg = format!("820182 00581c{me}");
    // Kyro's own encoding of a pool delegation and of a withdrawal, spliced into the legacy
    // fixtures: Trezor's hash proves both encodings.
    let deleg = body(
        vec![CardanoCert::StakeDelegation {
            stake: stake_hash(),
            pool: h28(POOL),
        }],
        vec![],
        false,
    )
    .encode();
    let deleg_cert = {
        let h = hex::encode(&deleg);
        let at = h.find("030a0481").unwrap() + 8; // after "ttl 10, 04: [": the certificate
        h[at..].to_string()
    };
    let reward = hex::encode(cardano_reward_address_bytes(
        Network::Mainnet,
        &stake_hash(),
    ));
    for (extra, hash, n) in [
        (
            format!("0481{legacy_reg}"),
            "1a3a295908afd8b2afc368071272d6964be6ee0af062bb765aea65ca454dc0c9",
            5,
        ),
        (
            format!("0482{legacy_reg}{deleg_cert}"),
            "439764b5f7e08839881536a3191faeaf111e75d9f00f83b102c5c1c6fa9fcaf9",
            5,
        ),
        (
            format!("0481{legacy_dereg}"),
            "3aca1784d151dc75bdbb80fae71bda3f4b26af3f5fd71bd5e9e9bbcdd2b64ad1",
            5,
        ),
        (
            format!("0481{legacy_dereg}05a1581d{reward}1903e8"),
            "22c67f12e6f6aa0f2f09fd27d472b19c7208ccd7c3af4b09604fd5d462c1de2b",
            6,
        ),
    ] {
        let b = body_hex(n, &extra.replace(' ', ""));
        assert_eq!(
            hex::encode(cardano_blake2b256(&hex::decode(&b).unwrap())),
            hash,
            "{extra}"
        );
        let stake_pk: [u8; 32] = hex::decode(STAKE_PK).unwrap().try_into().unwrap();
        let e = cardano_decode_stake_tx(&unsigned(&b), &ctx(), &stake_pk, DEPOSIT)
            .unwrap_err()
            .to_string();
        assert!(e.contains("legacy"), "{e}");
    }
    // Trezor's withdrawal from m/1852'/1815'/0'/2/1: the encoding is the same as Kyro's, but it is
    // another stake credential than ours, so it is refused.
    let other = cardano_blake2b224(&hex::decode(STAKE_PK_2_1).unwrap());
    let b = body(
        vec![],
        vec![(cardano_reward_address_bytes(Network::Mainnet, &other), 1000)],
        false,
    );
    assert_eq!(
        hex::encode(b.tx_id()),
        "ac4bdaaf2288a0108654919e7f89811b32274d54da834162e407635db39de4f4"
    );
    let u = hex::encode(cardano_unsigned_tx(&b, None).unwrap());
    let e = cardano_sign_stake(&root(), 0, 0, 0, &u, &ctx(), DEPOSIT)
        .unwrap_err()
        .to_string();
    assert!(e.contains("reward account other than yours"), "{e}");
}

/// Audit finding: « the only output is our own address » was a shell rule; wallet-core signed a
/// staking transaction paying anyone.
#[test]
fn staking_transaction_pays_only_our_address() {
    let stake_pk: [u8; 32] = hex::decode(STAKE_PK).unwrap().try_into().unwrap();
    let deleg = || {
        vec![CardanoCert::StakeDelegation {
            stake: stake_hash(),
            pool: h28(POOL),
        }]
    };
    let decode = |b: &CardanoBody, c: &CardanoContext<'_>| {
        let u = hex::encode(cardano_unsigned_tx(b, None).unwrap());
        cardano_decode_stake_tx(&u, c, &stake_pk, DEPOSIT)
    };
    let b = body(deleg(), vec![], true);
    assert!(decode(&b, &ctx()).is_ok());
    // Same transaction, but the output is not one of our addresses.
    let not_ours = CardanoContext { own: &[], ..ctx() };
    let e = decode(&b, &not_ours).unwrap_err().to_string();
    assert!(e.contains("only pay your own address"), "{e}");
    let u = hex::encode(cardano_unsigned_tx(&b, None).unwrap());
    assert!(cardano_sign_stake(&root(), 0, 0, 0, &u, &not_ours, DEPOSIT).is_err());
    // A second output, even to our own address.
    let mut two = body(deleg(), vec![], true);
    two.outputs.push(two.outputs[0].clone());
    let e = decode(&two, &ctx()).unwrap_err().to_string();
    assert!(e.contains("a single output"), "{e}");
}

#[test]
fn foreign_credentials_and_other_certificates_are_refused() {
    let stake_pk: [u8; 32] = hex::decode(STAKE_PK).unwrap().try_into().unwrap();
    let refused = |b: CardanoBody, needle: &str| {
        let u = hex::encode(cardano_unsigned_tx(&b, None).unwrap());
        let e = cardano_decode_stake_tx(&u, &ctx(), &stake_pk, DEPOSIT)
            .unwrap_err()
            .to_string();
        assert!(e.contains(needle), "{needle}: {e}");
    };
    let other = cardano_blake2b224(&hex::decode(STAKE_PK_2_1).unwrap());
    // Another stake key in every certificate type.
    for c in [
        CardanoCert::StakeRegistration {
            stake: other,
            deposit: DEPOSIT,
        },
        CardanoCert::StakeDeregistration {
            stake: other,
            refund: DEPOSIT,
        },
        CardanoCert::StakeDelegation {
            stake: other,
            pool: h28(POOL),
        },
        CardanoCert::VoteDelegation {
            stake: other,
            drep: CardanoDrep::AlwaysAbstain,
        },
    ] {
        refused(body(vec![c], vec![], false), "stake key other than yours");
    }
    let me = stake_hash();
    // A deposit that is not the protocol's.
    refused(
        body(
            vec![CardanoCert::StakeRegistration {
                stake: me,
                deposit: 1,
            }],
            vec![],
            false,
        ),
        "deposit",
    );
    // Duplicates, register + deregister, delegate + deregister, registration not first.
    let reg = CardanoCert::StakeRegistration {
        stake: me,
        deposit: DEPOSIT,
    };
    let dereg = CardanoCert::StakeDeregistration {
        stake: me,
        refund: DEPOSIT,
    };
    let deleg = CardanoCert::StakeDelegation {
        stake: me,
        pool: h28(POOL),
    };
    refused(
        body(vec![deleg.clone(), deleg.clone()], vec![], false),
        "duplicate",
    );
    refused(
        body(vec![reg.clone(), dereg.clone()], vec![], false),
        "same transaction",
    );
    refused(
        body(vec![deleg.clone(), dereg], vec![], false),
        "same transaction",
    );
    refused(
        body(vec![deleg.clone(), reg.clone()], vec![], false),
        "first",
    );
    // Withdrawals: someone else's reward account, zero, two of them.
    let mine = cardano_reward_address_bytes(Network::Mainnet, &me);
    refused(
        body(
            vec![],
            vec![(cardano_reward_address_bytes(Network::Mainnet, &other), 5)],
            false,
        ),
        "reward account other than yours",
    );
    refused(body(vec![], vec![(mine.clone(), 0)], false), "0 lovelace");
    let mut script = mine.clone();
    script[0] = 0xF1; // script reward address
    refused(
        body(vec![], vec![(mine.clone(), 5), (script, 5)], false),
        "multiple withdrawals",
    );
    // A plain payment is not a staking transaction.
    refused(body(vec![], vec![], false), "no staking operation");

    // Raw certificate forms Kyro never accepts: script credential, pool registration (3),
    // combined (13), DRep registration (16), committee (14); and governance body fields.
    let me_hex = hex::encode(me);
    for (cert, needle) in [
        (format!("830782 01581c{me_hex}1a001e8480"), "script"),
        (format!("830382 00581c{me_hex}00"), "pool registration"),
        (format!("830d82 00581c{me_hex}00"), "combined"),
        (format!("831082 00581c{me_hex}00"), "DRep"),
        (format!("830e82 00581c{me_hex}00"), "committee"),
    ] {
        let b = body_hex(5, &format!("0481{cert}").replace(' ', ""));
        let e = cardano_decode_stake_tx(&unsigned(&b), &ctx(), &stake_pk, DEPOSIT)
            .unwrap_err()
            .to_string();
        assert!(e.contains(needle), "{needle}: {e}");
    }
    let deleg_hex = format!("830282 00581c{me_hex}581c{POOL}").replace(' ', "");
    for (k, v, what) in [("13", "a0", "votes"), ("14", "80", "proposals")] {
        let b = body_hex(6, &format!("0481{deleg_hex}{k}{v}"));
        let e = cardano_decode_stake_tx(&unsigned(&b), &ctx(), &stake_pk, DEPOSIT)
            .unwrap_err()
            .to_string();
        assert!(e.contains(what), "{what}: {e}");
    }
    // Metadata in a staking transaction.
    let aux = cardano_cip20_aux("hi").unwrap();
    let mut b = body(vec![deleg], vec![], false);
    b.aux_hash = Some(cardano_blake2b256(&aux));
    let u = hex::encode(cardano_unsigned_tx(&b, Some(&aux)).unwrap());
    let e = cardano_decode_stake_tx(&u, &ctx(), &stake_pk, DEPOSIT)
        .unwrap_err()
        .to_string();
    assert!(e.contains("metadata"), "{e}");
}

#[test]
fn withdrawal_and_delegation_views() {
    let me = stake_hash();
    let mine = cardano_reward_address_bytes(Network::Mainnet, &me);
    let b = body(
        vec![
            CardanoCert::StakeRegistration {
                stake: me,
                deposit: DEPOSIT,
            },
            CardanoCert::StakeDelegation {
                stake: me,
                pool: h28(POOL),
            },
            CardanoCert::VoteDelegation {
                stake: me,
                drep: CardanoDrep::AlwaysAbstain,
            },
        ],
        vec![],
        true,
    );
    let u = hex::encode(cardano_unsigned_tx(&b, None).unwrap());
    let (signed, _, s) = cardano_sign_stake(&root(), 0, 0, 0, &u, &ctx(), DEPOSIT).unwrap();
    assert_eq!(s.certificates.len(), 3);
    assert_eq!(
        s.certificates[1],
        CardanoCertView::StakeDelegation {
            pool_id: cardano_pool_bech32(&h28(POOL)).unwrap(),
            pool_hash: POOL.into()
        }
    );
    assert_eq!(
        s.certificates[2],
        CardanoCertView::VoteDelegation {
            drep: CardanoDrepView::AlwaysAbstain
        }
    );
    assert_eq!(cardano_signed_witnesses(&signed).unwrap().1.len(), 2);
    let b = body(vec![], vec![(mine, 1234)], false);
    let u = hex::encode(cardano_unsigned_tx(&b, None).unwrap());
    let (_, _, s) = cardano_sign_stake(&root(), 0, 0, 0, &u, &ctx(), DEPOSIT).unwrap();
    assert_eq!(s.withdrawn, "1234");
    assert_eq!(s.withdrawals[0].reward_address, s.stake_address);
    // Signing with a stake account whose key is not the one in the certificates: refused.
    let b = body(
        vec![CardanoCert::StakeDelegation {
            stake: me,
            pool: h28(POOL),
        }],
        vec![],
        false,
    );
    let u = hex::encode(cardano_unsigned_tx(&b, None).unwrap());
    assert!(cardano_sign_stake(&root(), 0, 0, 1, &u, &ctx(), DEPOSIT).is_err());
}

#[test]
fn pool_and_drep_identifiers() {
    let p = cardano_pool_bech32(&h28(POOL)).unwrap();
    assert!(p.starts_with("pool1"));
    assert_eq!(cardano_pool_id(&p).unwrap(), h28(POOL));
    assert_eq!(cardano_pool_id(POOL).unwrap(), h28(POOL));
    assert!(cardano_pool_id("pool1xyz").is_err());
    assert!(cardano_pool_id(&POOL[..54]).is_err());
    // A real preprod pool id (Koios pool_list, 2026-10-30) and its hex.
    assert_eq!(
        hex::encode(
            cardano_pool_id("pool187jmkalfzyz5cdlw4mxz9t9n8plcxpj7ve7a74mk05umvufp7jh").unwrap()
        ),
        "3fa5bb77e911054c37eeaecc22acb3387f83065e667ddf57767d39b6"
    );
    assert_eq!(
        cardano_drep_parse("alwaysAbstain").unwrap(),
        CardanoDrep::AlwaysAbstain
    );
    assert_eq!(
        cardano_drep_parse("alwaysNoConfidence").unwrap(),
        CardanoDrep::AlwaysNoConfidence
    );
    // CIP-129 round trip, key and script.
    for d in [
        CardanoDrep::Key(h28(DREP_HASH)),
        CardanoDrep::Script(h28(DREP_HASH)),
    ] {
        let id = cardano_drep_id(&d).unwrap();
        assert!(id.starts_with("drep1"));
        assert_eq!(cardano_drep_parse(&id).unwrap(), d);
    }
    // Real preprod CIP-129 DRep id (Koios drep_list, 2026-10-30): script DRep with this hash.
    assert_eq!(
        cardano_drep_parse("drep1yvqy2gsttpnpf3k2hz68u0fqcpzfzkyezk3agq983y6w65q4gagwj").unwrap(),
        CardanoDrep::Script(h28(
            "0045220b586614c6cab8b47e3d20c04491589915a3d400a78934ed50"
        ))
    );
    assert!(cardano_drep_parse("pool1abc").is_err());
    assert!(cardano_drep_parse("abstain").is_err());
}
