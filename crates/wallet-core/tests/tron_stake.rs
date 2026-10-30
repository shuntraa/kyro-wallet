//! TRON Stake 2.0 and voting.
//!
//! Vectors: Trezor firmware fixtures `common/tests/fixtures/tron/sign_tx.json` (trezor-firmware
//! commit f158cb46, mnemonic `all × 12`, owner `m/44'/195'/0'/0/0`): `raw_data_hex` of
//! FreezeBalanceV2, UnfreezeBalanceV2, WithdrawExpireUnfreeze, WithdrawBalance, VoteWitness and
//! DelegateResource / UnDelegateResource transactions, with Trezor's signatures. Kyro must decode
//! and re-encode each one identically, refuse the delegations, and sign the others with a
//! byte-identical signature (RFC 6979, like Trezor).

use wallet_core::{
    tron_address, tron_decode_raw, tron_decode_stake_raw, tron_recover_signer, tron_stake_sign,
    Mnemonic, TronContract, TronRaw, TronResource, TronStakeAction,
};

const ALL: &str = "all all all all all all all all all all all all";
const OWNER: &str = "TY72iA3SBtrds3QLYsS7LwYfkzXwAXCRWT";

/// `(name, our address index or 99 for Trezor's "different owner" key, raw_data_hex, signature)`.
const TREZOR: &[(&str, u32, &str, &str)] = &[
    ("Stake_for_Energy", 0, "0a027e0b2208ed0f599cb230d51240f884eee8c3335a5a083612560a34747970652e676f6f676c65617069732e636f6d2f70726f746f636f6c2e467265657a6542616c616e63655632436f6e7472616374121e0a1541f2cd810c48c401d392ead3c6e1e1cb9f57750a581080e1eb1718017098b0eae8c333", "39114ab6d33aafc741057c7245272b286d71fd4242052445cd058170073bbee1534e6752f2d1a305916fbac06fb0803641df604c713ee927e872a0ad972d18d01c"),
    ("Stake_for_Bandwidth", 0, "0a027dd72208007205b57e8b55104098c2e4e8c3335a5c083612580a34747970652e676f6f676c65617069732e636f6d2f70726f746f636f6c2e467265657a6542616c616e63655632436f6e747261637412200a1541f2cd810c48c401d392ead3c6e1e1cb9f57750a5810d4a78dafba93b11070b8ede0e8c333", "046e780100fff665c831d7d70d5fe34e5c5a29aadfb18cd15fd707576799690e75006369ea9327121862edbd17abd218ec40a50f32e7636975f7b4d5445f1fce1c"),
    ("Unstake_for_Energy", 0, "0a02d991220843b74d04209c177740a8c28986c7335a5c083712580a36747970652e676f6f676c65617069732e636f6d2f70726f746f636f6c2e556e667265657a6542616c616e63655632436f6e7472616374121e0a1541f2cd810c48c401d392ead3c6e1e1cb9f57750a581080ade204180170c8cebc85c733", "1f3a3c4028ef2e11a1c904b746f1136f2535c1eacf652eec89d7d3604565af7d0a1cfa24a10408d8146ac01e055b7fec25fc863bb636c7b85dad7018de528b161b"),
    ("Unstake_for_Bandwidth", 0, "0a02f2b72208fb75c38816f843ef40e8b7b08fc7335a5a083712560a36747970652e676f6f676c65617069732e636f6d2f70726f746f636f6c2e556e667265657a6542616c616e63655632436f6e7472616374121c0a1541f2cd810c48c401d392ead3c6e1e1cb9f57750a581080ade2047088c4e38ec733", "b4d10dbd35e1c4e925f45c38809e648df9936f6e5a9fa49ffd90f6ca81abc0595aa388f797114963a5a2be71b982832112846dfdd5b8125c0bcedb2822047a591b"),
    ("Claim_Unfrozen_Balance", 0, "0a02f55c2208e53dfa7c9386629740d0bfad90c7335a5a083812560a3b747970652e676f6f676c65617069732e636f6d2f70726f746f636f6c2e5769746864726177457870697265556e667265657a65436f6e747261637412170a1541f2cd810c48c401d392ead3c6e1e1cb9f57750a5870f0cbe08fc733", "833f6ba5c449a28ee6c58d98298f2f7cce8be1b7f70396e763ec216ca1d396b152bcefe9c7dde9970db2f1d38ecfba5aa20023f966f685da0048944415cb56f31c"),
    ("Claim_Unfrozen_Balance_different_owner", 99, "0a02f55c2208e53dfa7c9386629740d0bfad90c7335a5a083812560a3b747970652e676f6f676c65617069732e636f6d2f70726f746f636f6c2e5769746864726177457870697265556e667265657a65436f6e747261637412170a1541f2cd810c48c401d392ead3c6e1e1cb9f57750a5870f0cbe08fc733", "09994796d64065ab43cff4753d234a74e200ad2ba19139bf31427a4bde627ba305b48e5523ae958b538815eba9ea0b1728aed6a3e0f373c1dcac9094da29cee61c"),
    ("Claim_Voting_Rewards", 0, "0a02cb1c2208bda32dda749273264080e7ceffeb335a53080d124f0a34747970652e676f6f676c65617069732e636f6d2f70726f746f636f6c2e576974686472617742616c616e6365436f6e747261637412170a1541f2cd810c48c401d392ead3c6e1e1cb9f57750a5870a0f381ffeb33", "613af5d3a5190ce6f2ef4ff0a2164cd929950353e2a5d75190c927c6ff3277174d75ab0b2f1e3c2804de6f34d50d857c7a5b78043e61a448fa3f2bd7ce3ea5401b"),
    ("Claim_Voting_Rewards_different_owner", 99, "0a02cb1c2208bda32dda749273264080e7ceffeb335a53080d124f0a34747970652e676f6f676c65617069732e636f6d2f70726f746f636f6c2e576974686472617742616c616e6365436f6e747261637412170a1541f2cd810c48c401d392ead3c6e1e1cb9f57750a5870a0f381ffeb33", "0b0abd9f6014d36c49b1491507c456fbfcb2cc2577e21ef4ecb4affdc8cf4b0f69dac8c11c9c660f63f819d88bc93172e2951a532a7d58b24f3999a19f3fb5851c"),
    ("Vote_9_candidates", 0, "0a024cbf220846d6116f36a802ef40d8e3e2ccc9335ae002080412db020a30747970652e676f6f676c65617069732e636f6d2f70726f746f636f6c2e566f74655769746e657373436f6e747261637412a6020a1541f2cd810c48c401d392ead3c6e1e1cb9f57750a5812190a1541f16412b9a17ee9408646e2a21e16478f72ed1e95100312190a1541f279598aff304907ca03b0498c686d010d3d80bb1001121d0a1541cf9e12e0f48573c84bc88d8ff7c50567485aaa2410dfc4a9a201121d0a1541e76da262ad1ca05274f74258ee18bc7fcc4987dc10c8ccbeb701121d0a1541e61626ef01662b320a8ba38372e9db9cca940a3b10f1f7d3ed01121d0a1541290bf92b578a1c615ebb273aff6a285230c02f6510fad0c8bd03121d0a1541e71c365c9dbf284ca8c1eed2d7877638941b9011108fa3cad603121d0a1541977f82c69011cf4a7db6f7339edcded85c614d4510a88df7f801121d0a1541cd8d8ad1b4a5bd7afe46949421d2b411a360171710d3d2cfb80370f8ef95ccc933", "56dd74befa406b9f40552354f92e72ecf95857529b54dd06abff2543bb4a122d6fd0799b97909d0c0305e67ebf881608f7c4e867c5793c2d84cce9caee8041821b"),
    ("Vote_4_candidates", 0, "0a0216f122089595f045a80bd4af40b8eca1f6ca335ac101080412bc010a30747970652e676f6f676c65617069732e636f6d2f70726f746f636f6c2e566f74655769746e657373436f6e74726163741287010a1541f2cd810c48c401d392ead3c6e1e1cb9f57750a58121a0a1541f16412b9a17ee9408646e2a21e16478f72ed1e9510d65a121a0a1541f279598aff304907ca03b0498c686d010d3d80bb10d061121a0a1541cf9e12e0f48573c84bc88d8ff7c50567485aaa24109b14121a0a1541e76da262ad1ca05274f74258ee18bc7fcc4987dc10924370d8f8d4f5ca33", "2bac74b1801846677d0c675226e3de26c5360c095f6487b106103582f698c84638a2a120e64365186eef19f55dcdfa0c031fa1f7d2c27001b5483be0726c40101c"),
    ("Vote_10_candidates_too_many", 0, "0a0219102208aba08959fb60601640e08086f7ca335aeb02080412e6020a30747970652e676f6f676c65617069732e636f6d2f70726f746f636f6c2e566f74655769746e657373436f6e747261637412b1020a1541f2cd810c48c401d392ead3c6e1e1cb9f57750a58121a0a1541f16412b9a17ee9408646e2a21e16478f72ed1e9510e224121a0a1541f279598aff304907ca03b0498c686d010d3d80bb10f178121a0a1541cf9e12e0f48573c84bc88d8ff7c50567485aaa24109d63121b0a1541e76da262ad1ca05274f74258ee18bc7fcc4987dc10e79201121a0a1541e61626ef01662b320a8ba38372e9db9cca940a3b10e759121a0a1541290bf92b578a1c615ebb273aff6a285230c02f6510bb60121a0a1541e71c365c9dbf284ca8c1eed2d7877638941b901110cf7b121b0a1541977f82c69011cf4a7db6f7339edcded85c614d4510ab8701121a0a1541cd8d8ad1b4a5bd7afe46949421d2b411a3601717109f2b121a0a15410257b56399ef8d835b42f68e6476f7fe8ca2d28310d54b70808db9f6ca33", ""),
    ("Vote_1_candidate", 0, "0a024ea12208dee739b870d6de54409891bccdc9335a6b080412670a30747970652e676f6f676c65617069732e636f6d2f70726f746f636f6c2e566f74655769746e657373436f6e747261637412330a1541f2cd810c48c401d392ead3c6e1e1cb9f57750a58121a0a1541f16412b9a17ee9408646e2a21e16478f72ed1e9510e80770b89defccc933", "460fe864e1367df5c5b35e1c4a71588af06fd20337d2323b5c69fc6f31f1f9961374e0fb942aede50bbcdfebedadcb8f542c4b3188563d1c56fba3d52d59286b1b"),
    ("Delegate_Energy_with_lock_default_period", 0, "0a0266f522088f8142c7157dc54c40f8d9dedbeb335a77083912730a35747970652e676f6f676c65617069732e636f6d2f70726f746f636f6c2e44656c65676174655265736f75726365436f6e7472616374123a0a1541f2cd810c48c401d392ead3c6e1e1cb9f57750a58100118c0843d221541f59b1e8c74ed1a925eef999c9f6f2dac11c11a9f28013080a30570bab2ffd9eb33", "a5f63ccd2987772bba930a30ceb9afa71ed86646a5de8f4c61119262d26312b47ae1b14b338f2125fb729cb71fd9a69bd79407ac0a5cb530dbfaf4fdf1fb2fb51c"),
    ("Delegate_Energy_with_lock_no_period", 0, "0a025c1a220817c5a464f19f4fb640f0dcdcd7eb335a730839126f0a35747970652e676f6f676c65617069732e636f6d2f70726f746f636f6c2e44656c65676174655265736f75726365436f6e747261637412360a1541f2cd810c48c401d392ead3c6e1e1cb9f57750a58100118c0843d221541f59b1e8c74ed1a925eef999c9f6f2dac11c11a9f280170d0b9fdd5eb33", "c05c95aabc04b7e6063928379ef1a843fba63556880255697503b39c6bc51fa34427cca7a6030d0971aa0cb3c18dbf548c3f49439456a9e057ca14fff7648fff1c"),
    ("Delegate_Energy", 0, "0a025c2222087fbe4c8e28c4be6740b098ded7eb335a710839126d0a35747970652e676f6f676c65617069732e636f6d2f70726f746f636f6c2e44656c65676174655265736f75726365436f6e747261637412340a1541f2cd810c48c401d392ead3c6e1e1cb9f57750a58100118c0843d221541f59b1e8c74ed1a925eef999c9f6f2dac11c11a9f70f2f9fed5eb33", "f97c4162cbc8d3761ff85761ffaf23ace493037ce55b0a5276585ccb3fdcf813251bc6480eda6843ea13d9fbe35c4aa084e66c2e1371160dfb8dae06a2c7c2631b"),
    ("Delegate_Bandwidth", 0, "0a02f369220872bad941dfc6ff1740a8f0ffb0eb335a6f0839126b0a35747970652e676f6f676c65617069732e636f6d2f70726f746f636f6c2e44656c65676174655265736f75726365436f6e747261637412320a1541f2cd810c48c401d392ead3c6e1e1cb9f57750a5818c0843d221541f59b1e8c74ed1a925eef999c9f6f2dac11c11a9f70a3cda0afeb33", "390e587ef879d512bb211854b07341ddfdc385f783698524750d7255c77309bb5401dc47ac4746b9013100729eebd33ebe58b1bbb035c698a8678dd1143b9efa1c"),
    ("Delegate_Energy_with_lock_period", 0, "0a0296fd220801173b845095f92140d8efc0edeb335a77083912730a35747970652e676f6f676c65617069732e636f6d2f70726f746f636f6c2e44656c65676174655265736f75726365436f6e7472616374123a0a1541f2cd810c48c401d392ead3c6e1e1cb9f57750a58100118c0843d221541f59b1e8c74ed1a925eef999c9f6f2dac11c11a9f280130c0c40770f8bfe1ebeb33", "f68796ebbf5c9306c2e6468e5a7c030b7325b704d5a62350b378199af7b35b24461c44bb5ffb894626505bf0403152a6c6955897a1005486c54d0fba9fb88e101c"),
    ("Undelegate_Bandwidth", 0, "0a02f37d220896f8f7fefcf225a1408887f1afeb335a71083a126d0a37747970652e676f6f676c65617069732e636f6d2f70726f746f636f6c2e556e44656c65676174655265736f75726365436f6e747261637412320a1541f2cd810c48c401d392ead3c6e1e1cb9f57750a5818c0843d221541f59b1e8c74ed1a925eef999c9f6f2dac11c11a9f70ff9fa4afeb33", "c53e9f67de5b57834e22603934ca3d35a15d0186e37e761c59163c66fccfa74f1dba4129f6f0ca4a6aedf963cb50031569d9d044bf4eab7cc3507f5461b1f7e71c"),
];

fn seed() -> wallet_core::Seed {
    Mnemonic::parse(ALL).unwrap().to_seed("")
}

fn vector(name: &str) -> &'static str {
    TREZOR.iter().find(|v| v.0 == name).unwrap().2
}

#[test]
fn trezor_stake_vectors_decode_reencode_and_sign_identically() {
    let s = seed();
    assert_eq!(tron_address(&s, 0).unwrap(), OWNER);
    for (name, idx, raw, sig) in TREZOR {
        let bytes = hex::decode(raw).unwrap();
        let decoded = TronRaw::decode(&bytes);
        if name.starts_with("Delegate") || name.starts_with("Undelegate") {
            let e = decoded.unwrap_err().to_string();
            assert!(e.contains("délégation de ressources"), "{name}: {e}");
            assert!(tron_decode_stake_raw(raw, OWNER).is_err());
            continue;
        }
        let tx = decoded.unwrap_or_else(|e| panic!("{name}: {e}"));
        assert_eq!(hex::encode(tx.encode()), *raw, "{name}: re-encoding");
        assert!(tx.is_staking());
        // The payment decoder never accepts them.
        assert!(tron_decode_raw(raw, OWNER).is_err(), "{name}");
        let summary = tron_decode_stake_raw(raw, OWNER).unwrap();
        if *idx == 99 {
            // Trezor's "different owner": signed by m/44'/195'/0'/1/0, not the owner. Kyro only
            // signs with the owner's key: with any other of its keys it refuses.
            assert!(tron_stake_sign(&s, 1, raw).is_err(), "{name}");
            continue;
        }
        if sig.is_empty() {
            continue; // Vote_10: refused by Trezor (its 9-vote screen limit), no signature.
        }
        let (got, again) = tron_stake_sign(&s, *idx, raw).unwrap();
        assert_eq!(again, summary);
        assert_eq!(hex::encode(got), *sig, "{name}: signature");
        assert_eq!(tron_recover_signer(raw, &got).unwrap(), OWNER);
    }
}

#[test]
fn trezor_stake_summaries() {
    let s = tron_decode_stake_raw(vector("Stake_for_Energy"), OWNER).unwrap();
    assert_eq!(
        s.action,
        TronStakeAction::Freeze {
            resource: TronResource::Energy,
            amount: "50000000".into()
        }
    );
    assert_eq!(
        s.txid,
        "310c0ffb157a8432c75cf2c9d03df6503002fa5d237f2eade6446b691ba30ead"
    );
    let s = tron_decode_stake_raw(vector("Stake_for_Bandwidth"), OWNER).unwrap();
    assert_eq!(
        s.action,
        TronStakeAction::Freeze {
            resource: TronResource::Bandwidth,
            amount: "9223372036854740".into()
        }
    );
    assert_eq!(
        tron_decode_stake_raw(vector("Unstake_for_Energy"), OWNER)
            .unwrap()
            .action,
        TronStakeAction::Unfreeze {
            resource: TronResource::Energy,
            amount: "10000000".into()
        }
    );
    assert_eq!(
        tron_decode_stake_raw(vector("Claim_Unfrozen_Balance"), OWNER)
            .unwrap()
            .action,
        TronStakeAction::WithdrawUnfrozen
    );
    assert_eq!(
        tron_decode_stake_raw(vector("Claim_Voting_Rewards"), OWNER)
            .unwrap()
            .action,
        TronStakeAction::ClaimRewards
    );
    let TronStakeAction::Vote { votes, total } =
        tron_decode_stake_raw(vector("Vote_4_candidates"), OWNER)
            .unwrap()
            .action
    else {
        panic!("vote")
    };
    assert_eq!(votes.len(), 4);
    assert_eq!(votes[0].count, "11606");
    assert_eq!(total, (11606 + 12496 + 2587 + 8594).to_string());
    // 10 votes: within TRON's limit of 30 (Trezor's own limit is 9).
    let TronStakeAction::Vote { votes, .. } =
        tron_decode_stake_raw(vector("Vote_10_candidates_too_many"), OWNER)
            .unwrap()
            .action
    else {
        panic!("vote")
    };
    assert_eq!(votes.len(), 10);
    // Another owner than us.
    assert!(tron_decode_stake_raw(
        vector("Vote_1_candidate"),
        "TFz2CJn9CJb8C4i1Gke3jmZX2fRMJxniH2"
    )
    .is_err());
}

fn base(contract: TronContract) -> TronRaw {
    TronRaw {
        ref_block_bytes: [0x7e, 0x0b],
        ref_block_hash: [0xed, 0x0f, 0x59, 0x9c, 0xb2, 0x30, 0xd5, 0x12],
        expiration: 1_770_551_739_000,
        memo: Vec::new(),
        contract,
        timestamp: 1_770_551_679_000,
        fee_limit: 0,
    }
}

#[test]
fn stake_refusals() {
    let owner = wallet_core::tron_address_bytes(OWNER).unwrap();
    let sr = wallet_core::tron_address_bytes("TJmka325yjJKeFpQDwKSQAoNwEyNGhsaEV").unwrap();
    let refused = |raw: &TronRaw, needle: &str| {
        let e = tron_decode_stake_raw(&hex::encode(raw.encode()), OWNER)
            .unwrap_err()
            .to_string();
        assert!(e.contains(needle), "{needle}: {e}");
    };
    // Zero amounts.
    refused(
        &base(TronContract::FreezeV2 {
            owner,
            amount: 0,
            resource: TronResource::Energy,
        }),
        "positif",
    );
    refused(
        &base(TronContract::UnfreezeV2 {
            owner,
            amount: 0,
            resource: TronResource::Bandwidth,
        }),
        "positif",
    );
    // Memo, fee_limit.
    let mut r = base(TronContract::WithdrawBalance { owner });
    r.memo = b"hi".to_vec();
    refused(&r, "mémo");
    let mut r = base(TronContract::WithdrawBalance { owner });
    r.fee_limit = 1;
    refused(&r, "fee_limit");
    // Votes: none, 31, duplicate SR, zero.
    refused(
        &base(TronContract::VoteWitness {
            owner,
            votes: vec![],
        }),
        "1 à 30",
    );
    refused(
        &base(TronContract::VoteWitness {
            owner,
            votes: (0..31u8)
                .map(|i| {
                    let mut a = sr;
                    a[20] = i;
                    (a, 1)
                })
                .collect(),
        }),
        "1 à 30",
    );
    refused(
        &base(TronContract::VoteWitness {
            owner,
            votes: vec![(sr, 1), (sr, 2)],
        }),
        "deux fois",
    );
    refused(
        &base(TronContract::VoteWitness {
            owner,
            votes: vec![(sr, 0)],
        }),
        "positif",
    );
    // A TRX transfer is not a staking transaction.
    refused(
        &base(TronContract::Transfer {
            owner,
            to: sr,
            amount: 1,
        }),
        "pas une transaction de staking",
    );
    // TRON_POWER resource (2) and the deprecated `support` field: refused by the strict decoder.
    let tp = vector("Stake_for_Energy").replace("17180170", "17180270");
    let e = TronRaw::decode(&hex::decode(&tp).unwrap())
        .unwrap_err()
        .to_string();
    assert!(e.contains("TRON_POWER"), "{e}");
    let v1 = vector("Vote_1_candidate");
    // Append `support = true` (field 3, 1801) to the VoteWitnessContract value, lengths adjusted.
    let with_support = v1
        .replace("5a6b080412670a30", "5a6d080412690a30")
        .replace("12330a1541f2cd", "12350a1541f2cd")
        .replace("10e80770", "10e807180170");
    assert_ne!(with_support, v1);
    let e = TronRaw::decode(&hex::decode(&with_support).unwrap())
        .unwrap_err()
        .to_string();
    assert!(e.contains("support"), "{e}");
}
