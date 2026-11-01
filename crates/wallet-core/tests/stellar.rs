//! Stellar vectors.
//!
//! Sources (fetched 2026-11-01):
//! - SEP-0005 (stellar-protocol `ecosystem/sep-0005.md`): the five official mnemonics, ten
//!   accounts each (`m/44'/148'/0'` … `/9'`), test 4 with a BIP39 passphrase;
//! - SEP-0023 (`ecosystem/sep-0023.md`): valid and invalid strkeys (account `G…`, muxed `M…`);
//! - real envelopes from Horizon (`horizon.stellar.org` and `horizon-testnet.stellar.org`,
//!   `/payments` and `/operations` with `join=transactions`): one operation each (Payment of XLM,
//!   USDC, a 12-character asset; CreateAccount; ChangeTrust), every memo type, with and without
//!   time bounds. Each must decode, re-encode to the same bytes, hash to Horizon's `hash` on its
//!   own network, and carry a valid signature of its source on that network only.

use wallet_core::{
    stellar_account_id, stellar_address, stellar_address_from_key, stellar_asset,
    stellar_decode_tx, stellar_muxed_parts, stellar_network_passphrase, stellar_sign,
    stellar_verify_signed, Error, Mnemonic, Network, StellarAsset, StellarAssetView,
    StellarEnvelope, StellarMemo, StellarMemoView, StellarOp, StellarOpView, StellarOperation,
    StellarTransaction, StellarWarning, STELLAR_MAINNET_PASSPHRASE, STELLAR_TESTNET_PASSPHRASE,
};

const SEP5: &[(&str, &str, [&str; 10])] = &[
    (
        "illness spike retreat truth genius clock brain pass fit cave bargain toe",
        "",
        [
            "GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6",
            "GBAW5XGWORWVFE2XTJYDTLDHXTY2Q2MO73HYCGB3XMFMQ562Q2W2GJQX",
            "GAY5PRAHJ2HIYBYCLZXTHID6SPVELOOYH2LBPH3LD4RUMXUW3DOYTLXW",
            "GAOD5NRAEORFE34G5D4EOSKIJB6V4Z2FGPBCJNQI6MNICVITE6CSYIAE",
            "GBCUXLFLSL2JE3NWLHAWXQZN6SQC6577YMAU3M3BEMWKYPFWXBSRCWV4",
            "GBRQY5JFN5UBG5PGOSUOL4M6D7VRMAYU6WW2ZWXBMCKB7GPT3YCBU2XZ",
            "GBY27SJVFEWR3DUACNBSMJB6T4ZPR4C7ZXSTHT6GMZUDL23LAM5S2PQX",
            "GAY7T23Z34DWLSTEAUKVBPHHBUE4E3EMZBAQSLV6ZHS764U3TKUSNJOF",
            "GDJTCF62UUYSAFAVIXHPRBR4AUZV6NYJR75INVDXLLRZLZQ62S44443R",
            "GBTVYYDIYWGUQUTKX6ZMLGSZGMTESJYJKJWAATGZGITA25ZB6T5REF44",
        ],
    ),
    (
        "resource asthma orphan phone ice canvas fire useful arch jewel impose vague theory cushion top",
        "",
        [
            "GAVXVW5MCK7Q66RIBWZZKZEDQTRXWCZUP4DIIFXCCENGW2P6W4OA34RH",
            "GDFCYVCICATX5YPJUDS22KM2GW5QU2KKSPPPT2IC5AQIU6TP3BZSLR5K",
            "GAUA3XK3SGEQFNCBM423WIM5WCZ4CR4ZDPDFCYSFLCTODGGGJMPOHAAE",
            "GAH3S77QXTAPZ77REY6LGFIJ2XWVXFOKXHCFLA6HQTL3POLVZJDHHUDM",
            "GCSCZVGV2Y3EQ2RATJ7TE6PVWTW5OH5SMG754AF6W6YM3KJF7RMNPB4Y",
            "GDKWYAJE3W6PWCXDZNMFNFQSPTF6BUDANE6OVRYMJKBYNGL62VKKCNCC",
            "GCDTVB4XDLNX22HI5GUWHBXJFBCPB6JNU6ZON7E57FA3LFURS74CWDJH",
            "GBTDPL5S4IOUQHDLCZ7I2UXJ2TEHO6DYIQ3F2P5OOP3IS7JSJI4UMHQJ",
            "GD3KWA24OIM7V3MZKDAVSLN3NBHGKVURNJ72ZCTAJSDTF7RIGFXPW5FQ",
            "GB3C6RRQB3V7EPDXEDJCMTS45LVDLSZQ46PTIGKZUY37DXXEOAKJIWSV",
        ],
    ),
    (
        "bench hurt jump file august wise shallow faculty impulse spring exact slush thunder author capable act festival slice deposit sauce coconut afford frown better",
        "",
        [
            "GC3MMSXBWHL6CPOAVERSJITX7BH76YU252WGLUOM5CJX3E7UCYZBTPJQ",
            "GB3MTYFXPBZBUINVG72XR7AQ6P2I32CYSXWNRKJ2PV5H5C7EAM5YYISO",
            "GDYF7GIHS2TRGJ5WW4MZ4ELIUIBINRNYPPAWVQBPLAZXC2JRDI4DGAKU",
            "GAFLH7DGM3VXFVUID7JUKSGOYG52ZRAQPZHQASVCEQERYC5I4PPJUWBD",
            "GAXG3LWEXWCAWUABRO6SMAEUKJXLB5BBX6J2KMHFRIWKAMDJKCFGS3NN",
            "GA6RUD4DZ2NEMAQY4VZJ4C6K6VSEYEJITNSLUQKLCFHJ2JOGC5UCGCFQ",
            "GCUDW6ZF5SCGCMS3QUTELZ6LSAH6IVVXNRPRLAUNJ2XYLCA7KH7ZCVQS",
            "GBJ646Q524WGBN5X5NOAPIF5VQCR2WZCN6QZIDOSY6VA2PMHJ2X636G4",
            "GDHX4LU6YBSXGYTR7SX2P4ZYZSN24VXNJBVAFOB2GEBKNN3I54IYSRM4",
            "GDXOY6HXPIDT2QD352CH7VWX257PHVFR72COWQ74QE3TEV4PK2KCKZX7",
        ],
    ),
    (
        "cable spray genius state float twenty onion head street palace net private method loan turn phrase state blanket interest dry amazing dress blast tube",
        "p4ssphr4se",
        [
            "GDAHPZ2NSYIIHZXM56Y36SBVTV5QKFIZGYMMBHOU53ETUSWTP62B63EQ",
            "GDY47CJARRHHL66JH3RJURDYXAMIQ5DMXZLP3TDAUJ6IN2GUOFX4OJOC",
            "GCLAQF5H5LGJ2A6ACOMNEHSWYDJ3VKVBUBHDWFGRBEPAVZ56L4D7JJID",
            "GBC36J4KG7ZSIQ5UOSJFQNUP4IBRN6LVUFAHQWT2ODEQ7Y3ASWC5ZN3B",
            "GA6NHA4KPH5LFYD6LZH35SIX3DU5CWU3GX6GCKPJPPTQCCQPP627E3CB",
            "GBOWMXTLABFNEWO34UJNSJJNVEF6ESLCNNS36S5SX46UZT2MNYJOLA5L",
            "GBL3F5JUZN3SQKZ7SL4XSXEJI2SNSVGO6WZWNJLG666WOJHNDDLEXTSZ",
            "GA5XPPWXL22HFFL5K5CE37CEPUHXYGSP3NNWGM6IK6K4C3EFHZFKSAND",
            "GDS5I7L7LWFUVSYVAOHXJET2565MGGHJ4VHGVJXIKVKNO5D4JWXIZ3XU",
            "GBOSMFQYKWFDHJWCMCZSMGUMWCZOM4KFMXXS64INDHVCJ2A2JAABCYRR",
        ],
    ),
    (
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
        "",
        [
            "GB3JDWCQJCWMJ3IILWIGDTQJJC5567PGVEVXSCVPEQOTDN64VJBDQBYX",
            "GDVSYYTUAJ3ACHTPQNSTQBDQ4LDHQCMNY4FCEQH5TJUMSSLWQSTG42MV",
            "GBFPWBTN4AXHPWPTQVQBP4KRZ2YVYYOGRMV2PEYL2OBPPJDP7LECEVHR",
            "GCCCOWAKYVFY5M6SYHOW33TSNC7Z5IBRUEU2XQVVT34CIZU7CXZ4OQ4O",
            "GCQ3J35MKPKJX7JDXRHC5YTXTULFMCBMZ5IC63EDR66QA3LO7264ZL7Q",
            "GDTA7622ZA5PW7F7JL7NOEFGW62M7GW2GY764EQC2TUJ42YJQE2A3QUL",
            "GD7A7EACTPTBCYCURD43IEZXGIBCEXNBHN3OFWV2FOX67XKUIGRCTBNU",
            "GAF4AGPVLQXFKEWQV3DZU5YEFU6YP7XJHAEEQH4G3R664MSF77FLLRK3",
            "GABTYCZJMCP55SS6I46SR76IHETZDLG4L37MLZRZKQDGBLS5RMP65TSX",
            "GAKFARYSPI33KUJE7HYLT47DCX2PFWJ77W3LZMRBPSGPGYPMSDBE7W7X",
        ],
    ),
];

/// `(network, Horizon hash, envelope, operation, destination or issuer, stroops, asset code,
/// memo type, memo)`.
type HorizonVector = (
    Network,
    &'static str,
    &'static str,
    &'static str,
    &'static str,
    i64,
    &'static str,
    &'static str,
    &'static str,
);
const HORIZON: &[HorizonVector] = &[
    (
        Network::Mainnet,
        "ebf1425590b9a630c6e0c69b10a9646d673530ccdc5570ed16f500f6d7c2192c",
        "AAAAAgAAAAAoCMgc1GsZJKDq7ur0R/7QADUkhtqQaPAAyWbM0nUzJwAAA+gD44RZAAAAAQAAAAEAAAAAAAAAAAAAAABq5pgDAAAAAAAAAAEAAAAAAAAAAQAAAAAUf7TqDivwKuacwnColfDEAuR6MTfvqnytWuQU+3xWXAAAAAAAAAAAAAAD6AAAAAAAAAAB0nUzJwAAAEBbkDPaBeSd1nWz502J9XsI+dKEP9dxsgSn9m8IrQEizKn2Em0PELLGgYzHk7DXmdg2xIRk/7RF1fxFVKgpqLkP",
        "payment",
        "GAKH7NHKBYV7AKXGTTBHBKEV6DCAFZD2GE367KT4VVNOIFH3PRLFZFVD",
        1000,
        "",
        "none",
        "",
    ),
    (
        Network::Mainnet,
        "83fa198c60d839394a39acc25dcfe39c8e1e24b0867e4d095583605c9ced3483",
        "AAAAAgAAAAAArgOfQ+r3eh4F3EiUQdEYgpj7TnCR7Sdlvu0vXCWSAAAADcIDclFDAACCngAAAAEAAAAARVeNcQAAAABq5sEFAAAAAAAAAAEAAAAAAAAAAQAAAAADgofm8gL53U+YMLtoeTr2tRp5WHU+NMFwaAxLI+UDcwAAAAFVU0RDAAAAADuZETgO/piLoKiQDrHP5E82b32+lGvtB3JA9/Yk3xXFAAAAAAExLQAAAAAAAAAAAVwlkgAAAABA5VqXD5EnPJcHowzwBGNne7VCSRZj6wAFwn82jdXWp9Gakhup60hjaAOXvHw1e4HGHIU8Wm6kZXBiqSF8DyfwCg==",
        "payment",
        "GABYFB7G6IBPTXKPTAYLW2DZHL3LKGTZLB2T4NGBOBUAYSZD4UBXGPWC",
        20000000,
        "USDC",
        "none",
        "",
    ),
    (
        Network::Mainnet,
        "485a4f81f40f62fee444026fa4087f005082bd4a691a5bf6854403c89b8c2838",
        "AAAAAgAAAACXjIB1fEp6rNZYuXFzza4WRKW8cIDZG37nqT69VYmG4AAAA+gD4HlBAAAsAwAAAAEAAAAAAAAAAAAAAABq5pdJAAAAA3FeJxhz/UYVgso432tNl447YSfBo4jIlDcH+MheUrYQAAAAAQAAAAAAAAABAAAAAJeMgHV8Snqs1li5cXPNrhZEpbxwgNkbfuepPr1ViYbgAAAAAAAAAAAAAAABAAAAAAAAAAFViYbgAAAAQOobtmwn+0H6hFnh3J6TKCb7mJ1wPtLTwj3x0IX+Vsin02tBfaNwitoXKbvRBVsJ/n7Akl8iGb8Hx1vXY7taPQE=",
        "payment",
        "GCLYZADVPRFHVLGWLC4XC46NVYLEJJN4OCANSG3646UT5PKVRGDOASTQ",
        1,
        "",
        "hash",
        "715e271873fd461582ca38df6b4d978e3b6127c1a388c8943707f8c85e52b610",
    ),
    (
        Network::Mainnet,
        "7a15057fa9ecca27cbf6c528fa3139630c79171bcfd366b1c6d8206fb9e769ac",
        "AAAAAgAAAAC+BqHVvr+fCXumnyrYYk0IQlFNRiRTU0G74uJtf4dM1AAADcEDZqDAAAAUBgAAAAEAAAAAWvfL1QAAAABq5/ZeAAAAAQAAAAk4MDQ1Mzk1ODUAAAAAAAABAAAAAAAAAAEAAAAAMNJxNVO6cQNnCy6cStT997SscqJmcmbs4oRymlH/PKIAAAAAAAAABtonAXEAAAAAAAAAAX+HTNQAAABA8BIVAw5AJuu2QkTKZZBd0Vxw1LORFGHjJBKw5KviLkb1jozT+iKXxIA2ww5dvgFrhba5AmXH1Ptg3qGhLv5gCw==",
        "payment",
        "GAYNE4JVKO5HCA3HBMXJYSWU7X33JLDSUJTHEZXM4KCHFGSR746KFN63",
        29429793137,
        "",
        "text",
        "804539585",
    ),
    (
        Network::Testnet,
        "13fd8b586369ea157d278b3e357966f6eac0b14f13b8be23b623873a59bc02cd",
        "AAAAAgAAAAB6UWHyVwk+cdUN1pPYturabeVvoWSZpCIyGc2lFORNiAAAAGQAAAemAAbuAwAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAABAAAAAHpRYfJXCT5x1Q3Wk9i26tpt5W+hZJmkIjIZzaUU5E2IAAAAAQAAAABm6MFbzHcXpLy05yP1VRuBngUo+8eiCXII2nibiBNFxAAAAAAAAAAAATEtAAAAAAAAAAABFORNiAAAAECIfhujSzZry2Ed/6lUr1lYSijFRImrgVofh/gN/ruVHAD9mb/zA52VZIb6BTZrIkB9Rzlns6gKsnLIVLDdEUgN",
        "payment",
        "GBTORQK3ZR3RPJF4WTTSH5KVDOAZ4BJI7PD2ECLSBDNHRG4ICNC4JJZV",
        20000000,
        "",
        "none",
        "",
    ),
    (
        Network::Testnet,
        "e064627aa2c5763fe31ce55b582944a33ae926e8f4a659e7b78121f010188b05",
        "AAAAAgAAAAD9y+rOnrZdobM+0XfwPMGI8z7eya9oSNMrYPoI0W/tYAAAAGQAA+0HAAEhiwAAAAAAAAADZRwS/nPfQCIKIUew3wTSAyqG+cw8DMHWnA8csMG2s8sAAAABAAAAAAAAAAEAAAAA/cvqzp62XaGzPtF38DzBiPM+3smvaEjTK2D6CNFv7WAAAAAAAAAAAAAAAAEAAAAAAAAAAdFv7WAAAABAehnk514ndo8yb/gYK7BSDzRk41sQeyvQ3wveQZDoxlRw0x6U0Indhvc/Jt8N2J16c1ibudaPwEzW5OHCa0pZCw==",
        "payment",
        "GD64X2WOT23F3INTH3IXP4B4YGEPGPW6ZGXWQSGTFNQPUCGRN7WWAKQS",
        1,
        "",
        "hash",
        "651c12fe73df40220a2147b0df04d2032a86f9cc3c0cc1d69c0f1cb0c1b6b3cb",
    ),
    (
        Network::Testnet,
        "0548bbb1d35a297ea662755f77a78278e294705158b384bcf57c496cfd3624b6",
        "AAAAAgAAAACXC34FiVJ6C5dxlvEJfvVEEiLLfkOczNBn//gNrCe+IwAAAGQAU9cgAAAAAgAAAAEAAAAAAAAAAAAAAABq5pW9AAAAAQAAABhiMDI3NTIyZDRlMmVmYzY3MDFhYTYwZmQAAAABAAAAAAAAAAEAAAAAKCa43vgshimI8K86Rm0PDMTnV38CG25s/Oiy+DjdgT8AAAACTU9OQVJFRgAAAAAAAAAAAGH+sTmLNJl2JP8rsQVZqqF0p9AjvyJiYxA+V7RnVrcZAAAAAAX14QAAAAAAAAAAAawnviMAAABAbsMhI3SEgyrJp0Ekr1TBmnR88G0BXGn8bhdWUBzp3056fmJukKw8UqLcOiO7iCxgAvmlbIE0fE06/JZH+3ibAg==",
        "payment",
        "GAUCNOG67AWIMKMI6CXTURTNB4GMJZ2XP4BBW3TM7TULF6BY3WAT73OY",
        100000000,
        "MONAREF",
        "text",
        "b027522d4e2efc6701aa60fd",
    ),
    (
        Network::Testnet,
        "8f217ab6afbc2b14c368fa4af9d88d09e481d376b5d3c835c4616587ce9bdefe",
        "AAAAAgAAAACXC34FiVJ6C5dxlvEJfvVEEiLLfkOczNBn//gNrCe+IwAAAGQAU9cgAAAAAQAAAAEAAAAAAAAAAAAAAABq5pWzAAAAAAAAAAEAAAAAAAAABgAAAAJNT05BUkVGAAAAAAAAAAAAYf6xOYs0mXYk/yuxBVmqoXSn0CO/ImJjED5XtGdWtxl//////////wAAAAAAAAABrCe+IwAAAEDC6rJQYUeHltXYs1FrooH9D4z8rvigV0xnh5jxBlYQ9Utz0eOJPTbmxJ404OxH71weI5D2ZC2DLnlzGAq018AK",
        "change_trust",
        "GBQ75MJZRM2JS5RE74V3CBKZVKQXJJ6QEO7SEYTDCA7FPNDHK23RTYS3",
        9223372036854775807,
        "MONAREF",
        "none",
        "",
    ),
    (
        Network::Testnet,
        "e506f85689e6b03d2da83f468c0b8eecdc0922a436c486d4521ae90f5f5e6938",
        "AAAAAgAAAADTMGqPyEjG+0Ty32dYF1JFSAR1EqTLM+1e9W974hagDAAAAGQAU9cYAAAAAgAAAAEAAAAAAAAAAAAAAABq5pWiAAAAAgAAAFTLuxwCAAAAAQAAAAAAAAABAAAAAJYskhnUzzIMDio95YBNevHHBU39VLJkrAoPhWIOtq35AAAAAVVTREMAAAAAQj59BfLsr7/sGSshWj8b6WrtuNjnAlSr40E+AgfeVrIAAAAAAB5lyAAAAAAAAAAB4hagDAAAAEAXsrNZ4KT/aGBk/YifgUTVhC2u96yeT0ZY8SE7bc1SV5aFvbdsTpn0NsIY/ky0XWZFRmkTKPE2NX8xMapuUooI",
        "payment",
        "GCLCZEQZ2THTEDAOFI66LACNPLY4OBKN7VKLEZFMBIHYKYQOW2W7T3Z6",
        1992136,
        "USDC",
        "id",
        "364195290114",
    ),
    (
        Network::Testnet,
        "9b483bc452a81aeaa55e701ff1f9c9934fc54892332f7707f0838314ec4c4439",
        "AAAAAgAAAACWLJIZ1M8yDA4qPeWATXrxxwVN/VSyZKwKD4ViDrat+QAAJxAAQgksAAAbhwAAAAEAAAAAAAAAAAAAAABq5pWbAAAAAAAAAAEAAAAAAAAAAQAAAADTMGqPyEjG+0Ty32dYF1JFSAR1EqTLM+1e9W974hagDAAAAAFVU0RDAAAAAEI+fQXy7K+/7BkrIVo/G+lq7bjY5wJUq+NBPgIH3layAAAAAAAeZcgAAAAAAAAAAQ62rfkAAABAkwd4ZnaM/CyazgjDn0bWIrJLuwQiWq++GYhpF4ItpC05xtwJEYpaR0nj+fJSfcEd34zXWESITQEXMksrLb0YAw==",
        "payment",
        "GDJTA2UPZBEMN62E6LPWOWAXKJCUQBDVCKSMWM7NL32W667CC2QAZ4LZ",
        1992136,
        "USDC",
        "none",
        "",
    ),
    (
        Network::Testnet,
        "5bb63b285ef6c7b05a4d3479eae992b71be04ffb98f52e4a30a521874cac08b1",
        "AAAAAgAAAADTMGqPyEjG+0Ty32dYF1JFSAR1EqTLM+1e9W974hagDAAAAGQAU9cYAAAAAQAAAAEAAAAAAAAAAAAAAABq5pWPAAAAAAAAAAEAAAAAAAAABgAAAAFVU0RDAAAAAEI+fQXy7K+/7BkrIVo/G+lq7bjY5wJUq+NBPgIH3layf/////////8AAAAAAAAAAeIWoAwAAABAtEfgn4iwzOALsDt1qCqRsWilQPbjG07+T8QZh+OW/j6pVXvi4hcwCK10x5rflmdwvKB2O7PHj5HlBaSr97tRBA==",
        "change_trust",
        "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
        9223372036854775807,
        "USDC",
        "none",
        "",
    ),
    (
        Network::Testnet,
        "a91eaf36515ffc4d7a313086d0d751063b5cbe6b2052b72db660e6713fdad3cb",
        "AAAAAgAAAABNo4pEEE2WIcTaJDPWmtX+IVv4QMaxmXhzrN8cBFIZVgAAAGQAU9cHAAAAAwAAAAEAAAAAAAAAAAAAAABq5pV9AAAAAQAAAAZub3RlIDMAAAAAAAEAAAAAAAAAAQAAAABbwlnLeb1agVvFkbkXYlnDf/WFKP9cXyKjTZ3ZFSm9TgAAAAAAAAAADk4cAAAAAAAAAAABBFIZVgAAAEA6qF7HCYyv5WH8bwsLQFMvoAXUxWhlSGKLrAOgIPJzEvubN//QgUIJL8ZYP4rsU9RZzSx4yrL9S+4wFRxY+MEK",
        "payment",
        "GBN4EWOLPG6VVAK3YWI3SF3CLHBX75MFFD7VYXZCUNGZ3WIVFG6U5WXY",
        240000000,
        "",
        "text",
        "note 3",
    ),
    (
        Network::Mainnet,
        "41ec9447fe12812a73f881ed2f0a96bfc19fe822cee185243b68aad0507f8e3f",
        "AAAAAgAAAAABoJBUUJSARAZfaHH+Q2ibv8cNlTWUfEknfFrKQGgkQQAAA+gD44RUAAAAAQAAAAEAAAAAAAAAAAAAAABq5pfqAAAAAgAAAAA8ClpfAAAAAQAAAAAAAAABAAAAAMcVrV7Azk5TEsaw4j7eYa6TpQ4I836k1m+k5ff/fJB6AAAAAAAAAAAAAAPoAAAAAAAAAAFAaCRBAAAAQFHPMXl95OrqCYoEsOhRsPVlE3hpDRfc21FDPvtVL6CTFZY5TDwM1hc7vt013yiUuCzL5He5xZgM/BZvM9Kuaw0=",
        "payment",
        "GDDRLLK6YDHE4UYSY2YOEPW6MGXJHJIOBDZX5JGWN6SOL577PSIHVE56",
        1000,
        "",
        "id",
        "1007311455",
    ),
    (
        Network::Mainnet,
        "134edc4cd72f4762fc497db11aa46398e32fbb599c13c5d2676724f00d37ed37",
        "AAAAAgAAAAAq2GL8Uvtu0incwVcr4m5xpogLjEFtFARO8IoQJasicwAAA+gD34SPAAGXBgAAAAEAAAAAAAAAAAAAAABq5pb1AAAAAAAAAAEAAAAAAAAAAAAAAAABoJBUUJSARAZfaHH+Q2ibv8cNlTWUfEknfFrKQGgkQQAAAAAAmh0gAAAAAAAAAAElqyJzAAAAQHkAsQENAemLSt7DU3KvI+kjG4bOo6I0QIQqCZTGAzRCQRbY/bOWXz6kDV+dJYMyFs/5+jt8YUub+QzONGTjIgI=",
        "create_account",
        "GAA2BECUKCKIARAGL5UHD7SDNCN37RYNSU2ZI7CJE56FVSSANASECHIS",
        10100000,
        "",
        "none",
        "",
    ),
    (
        Network::Mainnet,
        "f296fb61dee8c0d6dd9aabce871c9096cb8127e21890c2ae4eb8c03a2c4237b8",
        "AAAAAgAAAACEKg+AgzOfKpBX0AeWBlyGsK2yB66MR2+t4XfdcRcp7wAAAGQDyuIbAAVpMAAAAAAAAAABAAAADGNsYWltOjM1NDUyMAAAAAEAAAAAAAAAAQAAAAB/DZCTC7dnjQvNlrXOFV+Pj+LqX5hZRLuYld1pLiMqHgAAAAJUSEVUQQAAAAAAAAAAAAAAEF7qGaPwIA7l+j8WvYQfxz0HqTPj8ZDiF2bxvombFmMAAABdIdugAAAAAAAAAAABcRcp7wAAAED0rnKEAla7LlANw/t0iJvhKYGzeIYjem/CEM/KzYHb7uaKdH7GK/qWn2AeHJk+qktCre7fWj6Ysnb9f1O/cUEM",
        "payment",
        "GB7Q3EETBO3WPDILZWLLLTQVL6HY7YXKL6MFSRF3TCK522JOEMVB4LUQ",
        400000000000,
        "THETA",
        "text",
        "claim:354520",
    ),
    (
        Network::Mainnet,
        "554153df70b7f11263beaa68031d0647f05705e0d79bae5c9d8a8a09285209a3",
        "AAAAAgAAAACz/o0gIuZ32NrtkodSZnA3XDv0l1u8zrtwp6GFt8ycZwAAAGQDzuDLAAAAGwAAAAEAAAAAAAAAAAAAAABq5papAAAAAqaofGjQlG38AAAAAQAAAAAAAAABAAAAACYFa5MKQ2LrNygCFpR2OKHJVZRlqZ3/DPNTP8sLr+oxAAAAAVVTREMAAAAAO5kROA7+mIugqJAOsc/kTzZvfb6Ua+0HckD39iTfFcUAAAAAMup3owAAAAAAAAABt8ycZwAAAECGHYy+OFKLEUQw16dpFu+Bhf4UpeP2YguhrL0HE0qtbUSF4i2r4Ie6/3EK72/8JtFPV6Vkl22VIlW/+0YsjqsI",
        "payment",
        "GATAK24TBJBWF2ZXFABBNFDWHCQ4SVMUMWUZ37YM6NJT7SYLV7VDD2TR",
        854226851,
        "USDC",
        "id",
        "12008985196001259004",
    ),
    (
        Network::Testnet,
        "fcf30615a7b5fbadf52172a924611cf388e5c6f56ccc60bae753bd5d679d335b",
        "AAAAAgAAAACFtrue8YCRDfR0gPUevXz6lL5W2PI1OsL6EeMWB7r9ZQAAAH0AU9Z1AAAAAQAAAAEAAAAAAAAAAAAAAABq5pNbAAAAAQAAABFWaWEgU3RlbGxhckh1Yi5pbwAAAAAAAAEAAAAAAAAAAAAAAABks4T9/W4WhDvzYwSPwIbG5kvW8+/y4P53oi8zkQvqawAAAAAAmJaAAAAAAAAAAAEHuv1lAAAAQHPmP6G67pn0prYKQRy7Z4TB3dip+HhUZsOTTRaM1oq7jejyJ4RXqsiV77O6vFC9K1rULw/eBvCZDngeO6nXmQA=",
        "create_account",
        "GBSLHBH57VXBNBB36NRQJD6AQ3DOMS6W6PX7FYH6O6RC6M4RBPVGWVXI",
        10000000,
        "",
        "text",
        "Via StellarHub.io",
    ),
    (
        Network::Testnet,
        "354caf3453e960ebd08b3ab749800481f7498c8c006901746920158ea6dd6786",
        "AAAAAgAAAACDr3UND3fyRS1ShMLMRk5+3EqKiJAOWPkMcp1umyyeigAAAGQAU9XbAAAAAQAAAAEAAAAAAAAAAAAAAABq5pBbAAAAAAAAAAEAAAAAAAAAAAAAAADzWzBQJy/9Lb0MkLWs1ZnYfuOqguqqD/P+UkAB2jXcIwAAAAAF9eEAAAAAAAAAAAGbLJ6KAAAAQACo4vqEyygSIFY+f3qYYCF/x7JxoesJaO6yH0uhtWqm2cHO7PnmTJvaiimeQmewxJuIz4ONprukTTkQhi0+Aws=",
        "create_account",
        "GDZVWMCQE4X72LN5BSILLLGVTHMH5Y5KQLVKUD7T7ZJEAAO2GXOCHY3B",
        100000000,
        "",
        "none",
        "",
    ),
];

fn seed_of(words: &str, passphrase: &str) -> wallet_core::Seed {
    Mnemonic::parse(words).unwrap().to_seed(passphrase)
}

#[test]
fn sep0005_all_official_vectors() {
    for (words, pass, keys) in SEP5 {
        let s = seed_of(words, pass);
        for (i, want) in keys.iter().enumerate() {
            assert_eq!(
                &stellar_address(&s, i as u32).unwrap(),
                want,
                "{words} /{i}'"
            );
        }
    }
}

#[test]
fn sep0023_strkeys() {
    // Valid account: binary key of the SEP's `MuxedAccount` (after the 4-byte type).
    let g = "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ";
    let key = stellar_account_id(g).unwrap();
    assert_eq!(
        hex::encode(key),
        "3f0c34bf93ad0d9971d04ccc90f705511c838aad9734a4a2fb0d7a03fc7fe89a"
    );
    assert_eq!(stellar_address_from_key(&key), g);
    // Spaces around are tolerated (paste), nothing else.
    assert_eq!(stellar_account_id(&format!(" {g}\n")).unwrap(), key);
    // Valid muxed accounts: decoded (for the error message) but never accepted as a recipient.
    for (m, id) in [
        (
            "MA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJUAAAAAAAAAAAACJUQ",
            0u64,
        ),
        (
            "MA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVAAAAAAAAAAAAAJLK",
            9_223_372_036_854_775_808,
        ),
    ] {
        assert_eq!(stellar_muxed_parts(m).unwrap(), (g.to_owned(), id));
        assert!(
            matches!(stellar_account_id(m), Err(Error::InvalidInput(e)) if e.contains("M…")),
            "{m}"
        );
    }
    // A secret key pasted by mistake gets its own warning (SEP-0005 test 1, account 0).
    assert!(matches!(
        stellar_account_id("SBGWSG6BTNCKCOB3DIFBGCVMUPQFYPA2G4O34RMTB343OYPXU5DJDVMN"),
        Err(Error::InvalidInput(e)) if e.contains("CLÉ SECRÈTE")
    ));
    // Every invalid strkey of SEP-0023, plus lower case and the other key kinds.
    for bad in [
        "GAAAAAAAACGC6",
        "MA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJUAAAAAAAAAAAACJUR",
        "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZA",
        "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJUACUSI",
        "G47QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVP2I",
        "MA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVAAAAAAAAAAAAAJLKA",
        "MA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVAAAAAAAAAAAAAAV75I",
        "M47QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJUAAAAAAAAAAAACJUQ",
        "MA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJUAAAAAAAAAAAACJUK===",
        "MA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJUAAAAAAAAAAAACJUO",
        "PA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJUAAAAAQACAQDAQCQMBYIBEFAWDANBYHRAEISCMKBKFQXDAMRUGY4DUPB6IAAAAAAAAPM",
        "BAAD6DBUX6J22DMZOHIEZTEQ64CVCHEDRKWZONFEUL5Q26QD7R76RGR4TV",
        "WA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJUAAAAAAAAAAAAAWWA",
        "ga7qynf7sowq3glr2bgmzehxavirza4kvwltjjfc7mgxua74p7ujvsgz",
        "CA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJUWDA",
        "rNaqKtKrMSwpwZSzRckPf7S96DkimjkF4H",
        "",
    ] {
        assert!(stellar_account_id(bad).is_err(), "{bad}");
    }
}

#[test]
fn network_passphrases() {
    assert_eq!(
        stellar_network_passphrase(Network::Mainnet),
        "Public Global Stellar Network ; September 2015"
    );
    assert_eq!(
        STELLAR_MAINNET_PASSPHRASE,
        "Public Global Stellar Network ; September 2015"
    );
    assert_eq!(
        stellar_network_passphrase(Network::Testnet),
        STELLAR_TESTNET_PASSPHRASE
    );
    assert_eq!(
        STELLAR_TESTNET_PASSPHRASE,
        "Test SDF Network ; September 2015"
    );
}

fn other(net: Network) -> Network {
    match net {
        Network::Mainnet => Network::Testnet,
        Network::Testnet => Network::Mainnet,
    }
}

#[test]
fn horizon_envelopes_round_trip_hash_and_signature() {
    use base64::Engine as _;
    for (net, hash, b64, op, dest, stroops, code, memo_type, memo) in HORIZON {
        let raw = base64::engine::general_purpose::STANDARD
            .decode(b64)
            .unwrap();
        let env = StellarEnvelope::decode(&raw).unwrap_or_else(|e| panic!("{hash}: {e}"));
        assert_eq!(env.encode(), raw, "{hash}: identical re-encoding");
        assert_eq!(&env.to_base64(), b64);
        assert_eq!(hex::encode(env.tx.hash(*net)), *hash, "Horizon hash");
        assert_eq!(stellar_verify_signed(b64, *net).unwrap(), *hash);
        // Same bytes, other network: other hash, the signature no longer verifies.
        assert_ne!(hex::encode(env.tx.hash(other(*net))), *hash);
        assert!(stellar_verify_signed(b64, other(*net)).is_err(), "{hash}");
        let [o] = env.tx.operations.as_slice() else {
            panic!("{hash}: one operation")
        };
        // Some wallets repeat the source on the operation (Kyro never does, and refuses it).
        assert!(o.source.is_none() || o.source == Some(env.tx.source));
        let asset_code = |a: &StellarAsset| match a {
            StellarAsset::Native => String::new(),
            StellarAsset::Credit { code, .. } => code.clone(),
        };
        match (&o.body, *op) {
            (
                StellarOperation::Payment {
                    destination,
                    asset,
                    amount,
                },
                "payment",
            ) => {
                assert_eq!(stellar_address_from_key(destination), *dest);
                assert_eq!(amount, stroops);
                assert_eq!(asset_code(asset), *code);
            }
            (
                StellarOperation::CreateAccount {
                    destination,
                    starting_balance,
                },
                "create_account",
            ) => {
                assert_eq!(stellar_address_from_key(destination), *dest);
                assert_eq!(starting_balance, stroops);
            }
            (StellarOperation::ChangeTrust { asset, limit }, "change_trust") => {
                let StellarAsset::Credit { issuer, .. } = asset else {
                    panic!("credit asset")
                };
                assert_eq!(stellar_address_from_key(issuer), *dest);
                assert_eq!(asset_code(asset), *code);
                assert_eq!(*limit, i64::MAX);
                assert_eq!(limit, stroops);
            }
            (b, k) => panic!("{hash}: {k} decoded as {b:?}"),
        }
        let got = match &env.tx.memo {
            StellarMemo::None => ("none", String::new()),
            StellarMemo::Text(t) => ("text", String::from_utf8(t.clone()).unwrap()),
            StellarMemo::Id(id) => ("id", id.to_string()),
            StellarMemo::Hash(h) => ("hash", hex::encode(h)),
            StellarMemo::Return(h) => ("return", hex::encode(h)),
        };
        assert_eq!(got, (*memo_type, memo.to_string()), "{hash}: memo");
        // Every byte matters: a flipped bit anywhere is refused or changes the hash.
        for i in [8usize, raw.len() / 2, raw.len() - 70] {
            let mut m = raw.clone();
            m[i] ^= 1;
            if let Ok(e) = StellarEnvelope::decode(&m) {
                use base64::Engine as _;
                let b = base64::engine::general_purpose::STANDARD.encode(e.encode());
                assert!(stellar_verify_signed(&b, *net).is_err(), "{hash} byte {i}");
            }
        }
    }
}

const ABANDON: &str =
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

fn key(addr: &str) -> [u8; 32] {
    stellar_account_id(addr).unwrap()
}

/// SEP-0005 test 5, account 0 → account 1.
fn base_tx(body: StellarOperation) -> StellarTransaction {
    let s = seed_of(ABANDON, "");
    StellarTransaction {
        source: key(&stellar_address(&s, 0).unwrap()),
        fee: 100,
        sequence: 4_294_967_297,
        time_bounds: Some((0, 1_793_500_000)),
        memo: StellarMemo::None,
        operations: vec![StellarOp { source: None, body }],
    }
}

fn pay(stroops: i64) -> StellarOperation {
    StellarOperation::Payment {
        destination: key("GDVSYYTUAJ3ACHTPQNSTQBDQ4LDHQCMNY4FCEQH5TJUMSSLWQSTG42MV"),
        asset: StellarAsset::Native,
        amount: stroops,
    }
}

fn unsigned(tx: &StellarTransaction) -> String {
    StellarEnvelope {
        tx: tx.clone(),
        signatures: vec![],
    }
    .to_base64()
}

#[test]
fn sign_decode_and_verify() {
    let s = seed_of(ABANDON, "");
    let me = stellar_address(&s, 0).unwrap();
    let mut tx = base_tx(pay(12_345_678));
    tx.memo = StellarMemo::Id(12_008_985_196_001_259_004);
    let b64 = unsigned(&tx);
    let summary = stellar_decode_tx(&b64, &me, Network::Testnet).unwrap();
    assert_eq!(summary.network, Network::Testnet);
    assert_eq!(summary.source, me);
    assert_eq!(summary.fee, "100");
    assert_eq!(summary.sequence, "4294967297");
    assert_eq!((summary.min_time, summary.max_time), (0, 1_793_500_000));
    assert_eq!(
        summary.memo,
        StellarMemoView::Id {
            id: "12008985196001259004".into()
        }
    );
    assert_eq!(
        summary.operation,
        StellarOpView::Payment {
            destination: "GDVSYYTUAJ3ACHTPQNSTQBDQ4LDHQCMNY4FCEQH5TJUMSSLWQSTG42MV".into(),
            asset: StellarAssetView::Native,
            amount: "12345678".into(),
        }
    );
    assert!(!summary.requires_extra_confirmation);
    // Serialized as the IPC contract says.
    let j = serde_json::to_value(&summary).unwrap();
    assert_eq!(j["operation"]["kind"], "payment");
    assert_eq!(j["operation"]["asset"]["kind"], "native");
    assert_eq!(j["memo"]["kind"], "id");
    assert_eq!(j["maxTime"], 1_793_500_000u64);

    let (signed, hash, again) = stellar_sign(&s, 0, &b64, Network::Testnet).unwrap();
    assert_eq!(again, summary, "same summary at signing");
    assert_eq!(
        stellar_verify_signed(&signed, Network::Testnet).unwrap(),
        hash
    );
    assert_eq!(hash, hex::encode(tx.hash(Network::Testnet)));
    // Ed25519 is deterministic: same bytes every time.
    assert_eq!(
        stellar_sign(&s, 0, &b64, Network::Testnet).unwrap().0,
        signed
    );
    // The network passphrase is in what is signed: a testnet signature is not a mainnet one.
    assert!(stellar_verify_signed(&signed, Network::Mainnet).is_err());
    let (main, main_hash, _) = stellar_sign(&s, 0, &b64, Network::Mainnet).unwrap();
    assert_ne!(main, signed);
    assert_ne!(main_hash, hash);
    assert_eq!(
        stellar_verify_signed(&main, Network::Mainnet).unwrap(),
        main_hash
    );
    // Signed envelope: one signature, hint = last 4 bytes of our key.
    let env = StellarEnvelope::from_base64(&signed).unwrap();
    assert_eq!(env.tx, tx);
    assert_eq!(env.signatures.len(), 1);
    assert_eq!(env.signatures[0].hint, key(&me)[28..]);
    // An already signed envelope is not signed again, nor shown as unsigned.
    assert!(stellar_decode_tx(&signed, &me, Network::Testnet).is_err());
    assert!(stellar_sign(&s, 0, &signed, Network::Testnet).is_err());
    // Another account of the same wallet cannot sign it (source mismatch).
    assert!(stellar_sign(&s, 1, &b64, Network::Testnet).is_err());
    // A signature by another key (account 1) does not verify as the source's.
    let mut forged = env.clone();
    let s1 = stellar_sign(
        &s,
        1,
        &unsigned(&StellarTransaction {
            source: key(&stellar_address(&s, 1).unwrap()),
            operations: vec![StellarOp {
                source: None,
                body: StellarOperation::Payment {
                    destination: key(&me),
                    asset: StellarAsset::Native,
                    amount: 1,
                },
            }],
            ..tx.clone()
        }),
        Network::Testnet,
    )
    .unwrap()
    .0;
    forged.signatures = StellarEnvelope::from_base64(&s1).unwrap().signatures;
    assert!(stellar_verify_signed(&forged.to_base64(), Network::Testnet).is_err());
}

#[test]
fn create_account_change_trust_and_memos() {
    let s = seed_of(ABANDON, "");
    let me = stellar_address(&s, 0).unwrap();
    let mut tx = base_tx(StellarOperation::CreateAccount {
        destination: key("GDVSYYTUAJ3ACHTPQNSTQBDQ4LDHQCMNY4FCEQH5TJUMSSLWQSTG42MV"),
        starting_balance: 10_000_000,
    });
    tx.memo = StellarMemo::Text(b"facture 42".to_vec());
    let sum = stellar_decode_tx(&unsigned(&tx), &me, Network::Mainnet).unwrap();
    assert_eq!(
        sum.operation,
        StellarOpView::CreateAccount {
            destination: "GDVSYYTUAJ3ACHTPQNSTQBDQ4LDHQCMNY4FCEQH5TJUMSSLWQSTG42MV".into(),
            starting_balance: "10000000".into(),
        }
    );
    assert_eq!(
        sum.memo,
        StellarMemoView::Text {
            text: Some("facture 42".into()),
            hex: hex::encode("facture 42")
        }
    );
    // Invisible characters in a memo: shown cleaned, reinforced confirmation.
    tx.memo = StellarMemo::Text("a\u{202E}b".as_bytes().to_vec());
    let sum = stellar_decode_tx(&unsigned(&tx), &me, Network::Mainnet).unwrap();
    assert!(sum.warnings.contains(&StellarWarning::UnusualText));
    assert!(sum.requires_extra_confirmation);
    // Not UTF-8: no text, hex only, reinforced.
    tx.memo = StellarMemo::Text(vec![0xff, 0xfe]);
    let sum = stellar_decode_tx(&unsigned(&tx), &me, Network::Mainnet).unwrap();
    assert!(matches!(sum.memo, StellarMemoView::Text { text: None, .. }));
    assert!(sum.requires_extra_confirmation);
    // Return memo and high fee: reinforced.
    tx.memo = StellarMemo::Return([7; 32]);
    tx.fee = 200_000;
    let sum = stellar_decode_tx(&unsigned(&tx), &me, Network::Mainnet).unwrap();
    assert_eq!(
        sum.warnings,
        vec![StellarWarning::HighFee, StellarWarning::MemoReturn]
    );

    // USDC trustline (Circle's mainnet issuer), then its removal (limit 0).
    let usdc = stellar_asset(
        "USDC",
        "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    )
    .unwrap();
    let trust = |limit| {
        base_tx(StellarOperation::ChangeTrust {
            asset: usdc.clone(),
            limit,
        })
    };
    let sum = stellar_decode_tx(&unsigned(&trust(i64::MAX)), &me, Network::Mainnet).unwrap();
    assert_eq!(
        sum.operation,
        StellarOpView::ChangeTrust {
            asset: StellarAssetView::Credit {
                code: "USDC".into(),
                issuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN".into()
            },
            limit: i64::MAX.to_string(),
        }
    );
    assert!(sum.warnings.is_empty());
    let sum = stellar_decode_tx(&unsigned(&trust(0)), &me, Network::Mainnet).unwrap();
    assert_eq!(sum.warnings, vec![StellarWarning::RemoveTrustline]);
    // Asset codes: 1–12 alphanumerics; "XLM" from an issuer is not the native asset.
    for bad in ["", "TOOLONGCODE13", "US-D", "XLM", "xlm"] {
        assert!(
            stellar_asset(
                bad,
                "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"
            )
            .is_err(),
            "{bad}"
        );
    }
}

#[test]
fn refusals() {
    let s = seed_of(ABANDON, "");
    let me = stellar_address(&s, 0).unwrap();
    let refused = |tx: &StellarTransaction, why: &str| {
        let r = stellar_decode_tx(&unsigned(tx), &me, Network::Testnet);
        assert!(
            matches!(&r, Err(Error::InvalidInput(m)) if m.contains(why)),
            "{why}: {r:?}"
        );
        assert!(stellar_sign(&s, 0, &unsigned(tx), Network::Testnet).is_err());
    };
    let base = base_tx(pay(1_000));
    // No time bounds (valid for ever), maxTime 0, min > max.
    refused(
        &StellarTransaction {
            time_bounds: None,
            ..base.clone()
        },
        "aucune limite de temps",
    );
    refused(
        &StellarTransaction {
            time_bounds: Some((0, 0)),
            ..base.clone()
        },
        "limites de temps",
    );
    refused(
        &StellarTransaction {
            time_bounds: Some((10, 5)),
            ..base.clone()
        },
        "limites de temps",
    );
    refused(
        &StellarTransaction {
            fee: 0,
            ..base.clone()
        },
        "frais nuls",
    );
    refused(
        &StellarTransaction {
            sequence: 0,
            ..base.clone()
        },
        "séquence",
    );
    // Another source, two operations, none, an operation with its own source.
    refused(
        &StellarTransaction {
            source: key("GDVSYYTUAJ3ACHTPQNSTQBDQ4LDHQCMNY4FCEQH5TJUMSSLWQSTG42MV"),
            ..base.clone()
        },
        "source",
    );
    let mut two = base.clone();
    two.operations.push(two.operations[0].clone());
    refused(&two, "2 opérations");
    refused(
        &StellarTransaction {
            operations: vec![],
            ..base.clone()
        },
        "0 opérations",
    );
    let mut op_src = base.clone();
    op_src.operations[0].source = Some(key(&me));
    refused(&op_src, "propre source");
    // To oneself, zero / negative amount, negative trust limit, trust in one's own asset.
    refused(
        &base_tx(StellarOperation::Payment {
            destination: key(&me),
            asset: StellarAsset::Native,
            amount: 5,
        }),
        "soi-même",
    );
    refused(&base_tx(pay(0)), "montant");
    refused(&base_tx(pay(-1)), "montant");
    refused(
        &base_tx(StellarOperation::CreateAccount {
            destination: key(&me),
            starting_balance: 10_000_000,
        }),
        "propre compte",
    );
    refused(
        &base_tx(StellarOperation::CreateAccount {
            destination: key("GDVSYYTUAJ3ACHTPQNSTQBDQ4LDHQCMNY4FCEQH5TJUMSSLWQSTG42MV"),
            starting_balance: 0,
        }),
        "solde de départ",
    );
    let usdc = stellar_asset(
        "USDC",
        "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    )
    .unwrap();
    refused(
        &base_tx(StellarOperation::ChangeTrust {
            asset: usdc,
            limit: -1,
        }),
        "limite négative",
    );
    refused(
        &base_tx(StellarOperation::ChangeTrust {
            asset: StellarAsset::Credit {
                code: "KYRO".into(),
                issuer: key(&me),
            },
            limit: 1,
        }),
        "propre actif",
    );
}

/// Byte-level refusals of the codec: other envelope kinds, muxed accounts, unknown arms,
/// non-canonical encodings, trailing data.
#[test]
fn strict_codec() {
    use base64::Engine as _;
    let b64 = |raw: &[u8]| base64::engine::general_purpose::STANDARD.encode(raw);
    let s = seed_of(ABANDON, "");
    let me = stellar_address(&s, 0).unwrap();
    let good = StellarEnvelope {
        tx: base_tx(pay(1_000)),
        signatures: vec![],
    }
    .encode();
    assert!(StellarEnvelope::decode(&good).is_ok());
    let refused = |raw: Vec<u8>, why: &str| {
        let r = StellarEnvelope::decode(&raw);
        assert!(
            matches!(&r, Err(Error::InvalidInput(m)) if m.contains(why)),
            "{why}: {r:?}"
        );
        assert!(stellar_decode_tx(&b64(&raw), &me, Network::Testnet).is_err());
    };
    let with = |at: usize, bytes: &[u8]| {
        let mut r = good.clone();
        r.splice(at..at + bytes.len(), bytes.iter().copied());
        r
    };
    // Envelope types: v0, fee bump, unknown.
    refused(with(0, &[0, 0, 0, 0]), "v0");
    refused(with(0, &[0, 0, 0, 5]), "fee bump");
    refused(with(0, &[0, 0, 0, 9]), "type d'enveloppe");
    // Muxed source (KEY_TYPE_MUXED_ED25519 = 0x100).
    refused(with(4, &[0, 0, 1, 0]), "multiplexés");
    // Layout: type(4) source(36) fee(4) seq(8) cond(4) tb(16) memo(4) nops(4) opsrc(4) optype(4)
    let cond = 4 + 36 + 4 + 8;
    refused(with(cond, &[0, 0, 0, 2]), "PRECOND_V2");
    let memo = cond + 4 + 16;
    refused(with(memo, &[0, 0, 0, 5]), "type de mémo");
    let optype = memo + 4 + 4 + 4;
    refused(with(optype, &[0, 0, 0, 24]), "InvokeHostFunction");
    refused(with(optype, &[0, 0, 0, 8]), "AccountMerge");
    refused(with(optype, &[0, 0, 0, 5]), "SetOptions");
    refused(with(optype - 4, &[0, 0, 0, 2]), "source d'opération");
    // Soroban extension (ext v = 1), trailing byte, truncation.
    let ext = good.len() - 8;
    refused(with(ext, &[0, 0, 0, 1]), "Soroban");
    let mut trailing = good.clone();
    trailing.push(0);
    refused(trailing, "octets en trop");
    refused(good[..good.len() - 1].to_vec(), "tronquée");
    refused(vec![0; 5000], "trop grande");

    // Memo text with non-zero padding: refused (one encoding per value).
    let mut tx = base_tx(pay(1_000));
    tx.memo = StellarMemo::Text(b"abc".to_vec());
    let raw = StellarEnvelope {
        tx: tx.clone(),
        signatures: vec![],
    }
    .encode();
    let pad = memo + 4 + 4 + 3;
    assert_eq!(raw[pad], 0);
    let mut bad = raw.clone();
    bad[pad] = 1;
    refused(bad, "remplissage");
    // Memo text longer than 28 bytes.
    tx.memo = StellarMemo::Text(vec![b'a'; 29]);
    refused(
        StellarEnvelope {
            tx: tx.clone(),
            signatures: vec![],
        }
        .encode(),
        "trop long",
    );
    // Asset codes: "USD" as ALPHANUM12 (second encoding of a 4-char code), a zero byte inside
    // the code, a non-alphanumeric code.
    let credit = |code: &str| {
        let mut t = base_tx(StellarOperation::Payment {
            destination: key("GDVSYYTUAJ3ACHTPQNSTQBDQ4LDHQCMNY4FCEQH5TJUMSSLWQSTG42MV"),
            asset: StellarAsset::Credit {
                code: code.into(),
                issuer: key("GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"),
            },
            amount: 1,
        });
        t.memo = StellarMemo::None;
        StellarEnvelope {
            tx: t,
            signatures: vec![],
        }
        .encode()
    };
    let usd12 = {
        // Build the ALPHANUM12 layout by hand: asset type 2, "USD" + 9 zero bytes.
        let r = credit("USDCOIN");
        let at = optype + 4 + 36; // after the destination
        assert_eq!(&r[at..at + 4], &[0, 0, 0, 2]);
        let mut r = r;
        r.splice(at + 4..at + 16, b"USD\0\0\0\0\0\0\0\0\0".iter().copied());
        r
    };
    refused(usd12, "code d'actif");
    let mut hole = credit("USDC");
    let at = optype + 4 + 36 + 4;
    hole[at + 1] = 0; // "U\0DC"
    refused(hole, "code d'actif");
    let mut dash = credit("USDC");
    dash[at + 1] = b'-';
    refused(dash, "code d'actif");
    // ChangeTrust to the native asset or to a liquidity-pool share.
    let trust = StellarEnvelope {
        tx: base_tx(StellarOperation::ChangeTrust {
            asset: stellar_asset(
                "USDC",
                "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
            )
            .unwrap(),
            limit: 5,
        }),
        signatures: vec![],
    }
    .encode();
    let at = optype + 4;
    refused(with_bytes(&trust, at, &[0, 0, 0, 0]), "XLM natif");
    refused(with_bytes(&trust, at, &[0, 0, 0, 3]), "pool");
}

fn with_bytes(raw: &[u8], at: usize, bytes: &[u8]) -> Vec<u8> {
    let mut r = raw.to_vec();
    r.splice(at..at + bytes.len(), bytes.iter().copied());
    r
}
