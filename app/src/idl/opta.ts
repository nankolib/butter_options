/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/opta.json`.
 */
export type Opta = {
  "address": "CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq",
  "metadata": {
    "name": "opta",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Created with Anchor"
  },
  "instructions": [
    {
      "name": "autoCancelListings",
      "docs": [
        "V2 secondary listing \u2014 permissionless cleanup of stale listings at expiry.",
        "Spec: docs/V2_SECONDARY_LISTING_PLAN.md \u00a74.2 (Design A)."
      ],
      "discriminator": [
        94,
        64,
        222,
        215,
        220,
        179,
        240,
        248
      ],
      "accounts": [
        {
          "name": "caller",
          "docs": [
            "Permissionless caller \u2014 pays the tx fee."
          ],
          "signer": true
        },
        {
          "name": "sharedVault",
          "docs": [
            "Vault these listings belong to. Read-only."
          ]
        },
        {
          "name": "market",
          "docs": [
            "Market \u2014 pinned to the vault."
          ]
        },
        {
          "name": "vaultMintRecord",
          "docs": [
            "VaultMint record \u2014 pins option_mint to this vault."
          ]
        },
        {
          "name": "optionMint",
          "docs": [
            "The single Token-2022 mint shared by every listing in this batch."
          ],
          "writable": true
        },
        {
          "name": "protocolState",
          "docs": [
            "Protocol state \u2014 signs the escrow-source token-return transfers."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  116,
                  111,
                  99,
                  111,
                  108,
                  95,
                  118,
                  50
                ]
              }
            ]
          }
        },
        {
          "name": "transferHookProgram",
          "docs": [
            "Transfer hook program."
          ]
        },
        {
          "name": "extraAccountMetaList",
          "docs": [
            "ExtraAccountMetaList for the transfer hook."
          ]
        },
        {
          "name": "hookState",
          "docs": [
            "HookState for the transfer hook."
          ]
        },
        {
          "name": "token2022Program",
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "autoFinalizeHolders",
      "docs": [
        "Auto-burn holder option tokens + auto-pay ITM USDC for a settled vault.",
        "Permissionless. Caller passes `remaining_accounts` as pairs of",
        "(holder_option_ata, holder_usdc_ata). Idempotent: zero-amount accounts",
        "and mismatched USDC ATAs are skipped silently.",
        "See docs/AUTO_FINALIZE_PLAN.md."
      ],
      "discriminator": [
        137,
        143,
        14,
        164,
        172,
        162,
        193,
        160
      ],
      "accounts": [
        {
          "name": "caller",
          "docs": [
            "Permissionless caller \u2014 pays the tx fee. Not stored anywhere."
          ],
          "signer": true
        },
        {
          "name": "sharedVault",
          "docs": [
            "The settled shared vault."
          ],
          "writable": true
        },
        {
          "name": "market",
          "docs": [
            "The vault's market \u2014 pinned to the vault for sanity, not read in handler."
          ]
        },
        {
          "name": "vaultMintRecord",
          "docs": [
            "Per-mint tracking record. Pins option_mint to this vault so callers",
            "can't pass an unrelated mint with a matching vault."
          ]
        },
        {
          "name": "optionMint",
          "docs": [
            "The Token-2022 option mint being burned from. Must be `mut` so the",
            "burn CPI can decrement `supply` on the mint account."
          ],
          "writable": true
        },
        {
          "name": "vaultUsdcAccount",
          "docs": [
            "Vault's USDC account \u2014 payout source."
          ],
          "writable": true
        },
        {
          "name": "protocolState",
          "docs": [
            "Protocol state \u2014 PermanentDelegate authority on every option mint.",
            "Signs as `[b\"protocol_v2\", &[bump]]` to authorize the burns."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  116,
                  111,
                  99,
                  111,
                  108,
                  95,
                  118,
                  50
                ]
              }
            ]
          }
        },
        {
          "name": "token2022Program",
          "docs": [
            "Token-2022 program \u2014 for burning option tokens."
          ],
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        },
        {
          "name": "tokenProgram",
          "docs": [
            "Standard SPL Token program \u2014 for USDC transfers from vault \u2192 holder."
          ],
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": []
    },
    {
      "name": "autoFinalizeWriters",
      "docs": [
        "Auto-distribute USDC to writers + close their writer_position accounts",
        "for a settled vault. Permissionless. Caller passes `remaining_accounts`",
        "as triples of (writer_position, writer_usdc_ata, writer_wallet).",
        "Idempotent: closed writer_positions and mismatched USDC ATAs are",
        "skipped silently. When the last writer is processed, sweeps any USDC",
        "dust + the vault_usdc_account rent SOL to the protocol treasury.",
        "See docs/AUTO_FINALIZE_PLAN.md."
      ],
      "discriminator": [
        107,
        95,
        243,
        194,
        240,
        26,
        9,
        236
      ],
      "accounts": [
        {
          "name": "caller",
          "docs": [
            "Permissionless caller \u2014 pays the tx fee. Not stored anywhere."
          ],
          "signer": true
        },
        {
          "name": "sharedVault",
          "docs": [
            "The settled shared vault. Mut because we decrement collateral_remaining,",
            "total_shares, and total_collateral as each writer is processed."
          ],
          "writable": true
        },
        {
          "name": "market",
          "docs": [
            "The vault's market \u2014 pinned to the vault for sanity. Not read by the",
            "handler beyond the constraint."
          ]
        },
        {
          "name": "vaultUsdcAccount",
          "docs": [
            "Vault's USDC account \u2014 payout source for in-loop writer transfers and",
            "the last-writer dust sweep. Closed (with rent \u2192 treasury) when the last",
            "writer in the batch zeros total_shares."
          ],
          "writable": true
        },
        {
          "name": "treasury",
          "docs": [
            "Protocol treasury USDC account \u2014 receives any leftover dust + the",
            "vault_usdc_account rent SOL when the vault is fully drained. Pinned via",
            "protocol_state.treasury so callers can't redirect dust to themselves."
          ],
          "writable": true
        },
        {
          "name": "protocolState",
          "docs": [
            "Protocol state \u2014 supplies the canonical treasury pubkey for the",
            "constraint above."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  116,
                  111,
                  99,
                  111,
                  108,
                  95,
                  118,
                  50
                ]
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "docs": [
            "Standard SPL Token program \u2014 for USDC transfers and CloseAccount CPIs."
          ],
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": []
    },
    {
      "name": "burnUnsoldFromVault",
      "docs": [
        "Burn unsold option tokens from a vault mint, freeing committed collateral."
      ],
      "discriminator": [
        253,
        42,
        59,
        81,
        189,
        233,
        249,
        40
      ],
      "accounts": [
        {
          "name": "writer",
          "docs": [
            "The writer burning their unsold tokens."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "sharedVault",
          "docs": [
            "The shared vault."
          ],
          "writable": true
        },
        {
          "name": "writerPosition",
          "docs": [
            "Writer's position in the vault."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  119,
                  114,
                  105,
                  116,
                  101,
                  114,
                  95,
                  112,
                  111,
                  115,
                  105,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "sharedVault"
              },
              {
                "kind": "account",
                "path": "writer"
              }
            ]
          }
        },
        {
          "name": "vaultMintRecord",
          "docs": [
            "VaultMint record for this specific mint."
          ],
          "writable": true
        },
        {
          "name": "protocolState",
          "docs": [
            "Protocol state \u2014 signs as purchase escrow owner for the burn."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  116,
                  111,
                  99,
                  111,
                  108,
                  95,
                  118,
                  50
                ]
              }
            ]
          }
        },
        {
          "name": "optionMint",
          "docs": [
            "The Token-2022 option mint being burned."
          ],
          "writable": true
        },
        {
          "name": "purchaseEscrow",
          "docs": [
            "Purchase escrow holding the unsold tokens."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116,
                  95,
                  112,
                  117,
                  114,
                  99,
                  104,
                  97,
                  115,
                  101,
                  95,
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "sharedVault"
              },
              {
                "kind": "account",
                "path": "vault_mint_record.writer",
                "account": "vaultMint"
              },
              {
                "kind": "account",
                "path": "vault_mint_record.created_at",
                "account": "vaultMint"
              }
            ]
          }
        },
        {
          "name": "token2022Program",
          "docs": [
            "Token-2022 program."
          ],
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        }
      ],
      "args": []
    },
    {
      "name": "buyV2Resale",
      "docs": [
        "V2 secondary listing \u2014 fill (partially or fully) an existing listing.",
        "Spec: docs/V2_SECONDARY_LISTING_PLAN.md \u00a72.2."
      ],
      "discriminator": [
        201,
        254,
        202,
        255,
        49,
        103,
        103,
        239
      ],
      "accounts": [
        {
          "name": "buyer",
          "docs": [
            "Buyer \u2014 pays USDC, receives option tokens."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "sharedVault",
          "docs": [
            "Vault \u2014 read for collateral_mint constraints + is_settled / expiry guards."
          ]
        },
        {
          "name": "market",
          "docs": [
            "Market \u2014 pinned to the vault."
          ]
        },
        {
          "name": "vaultMintRecord",
          "docs": [
            "VaultMint record \u2014 pins option_mint to this vault."
          ]
        },
        {
          "name": "listing",
          "docs": [
            "Listing being filled. Mut for listed_quantity decrement. On full fill",
            "the handler manually closes via lamport drain + reassign + realloc",
            "(see auto_finalize_writers.rs:225-244 for the pattern). Anchor's",
            "`close = X` derive can't be conditional."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116,
                  95,
                  114,
                  101,
                  115,
                  97,
                  108,
                  101,
                  95,
                  108,
                  105,
                  115,
                  116,
                  105,
                  110,
                  103
                ]
              },
              {
                "kind": "account",
                "path": "optionMint"
              },
              {
                "kind": "account",
                "path": "listing.seller",
                "account": "vaultResaleListing"
              }
            ]
          }
        },
        {
          "name": "seller",
          "docs": [
            "Seller wallet \u2014 rent destination on full-fill close. Constraint pins",
            "it to listing.seller so a third-party caller can't redirect rent."
          ],
          "writable": true
        },
        {
          "name": "optionMint",
          "docs": [
            "Token-2022 mint."
          ],
          "writable": true
        },
        {
          "name": "resaleEscrow",
          "docs": [
            "Resale escrow \u2014 source of the option-token transfer."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116,
                  95,
                  114,
                  101,
                  115,
                  97,
                  108,
                  101,
                  95,
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "listing"
              }
            ]
          }
        },
        {
          "name": "buyerOptionAccount",
          "docs": [
            "Buyer's option ATA \u2014 destination. Frontend pre-creates idempotently."
          ],
          "writable": true
        },
        {
          "name": "buyerUsdcAccount",
          "docs": [
            "Buyer's USDC ATA."
          ],
          "writable": true
        },
        {
          "name": "sellerUsdcAccount",
          "docs": [
            "Seller's USDC ATA \u2014 receives seller-share. Must exist (Open Q #6 locked)."
          ],
          "writable": true
        },
        {
          "name": "treasury",
          "docs": [
            "Treasury \u2014 receives protocol fee."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  114,
                  101,
                  97,
                  115,
                  117,
                  114,
                  121,
                  95,
                  118,
                  50
                ]
              }
            ]
          }
        },
        {
          "name": "protocolState",
          "docs": [
            "Protocol state \u2014 fee_bps + total_volume + escrow signer authority."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  116,
                  111,
                  99,
                  111,
                  108,
                  95,
                  118,
                  50
                ]
              }
            ]
          }
        },
        {
          "name": "transferHookProgram",
          "docs": [
            "Transfer hook program."
          ]
        },
        {
          "name": "extraAccountMetaList",
          "docs": [
            "ExtraAccountMetaList for the transfer hook."
          ]
        },
        {
          "name": "hookState",
          "docs": [
            "HookState for the transfer hook."
          ]
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "token2022Program",
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "quantity",
          "type": "u64"
        },
        {
          "name": "maxTotalPrice",
          "type": "u64"
        }
      ]
    },
    {
      "name": "cancelOrder",
      "docs": [
        "Exchange book \u2014 owner cancels their own resting order; escrow + rent returned.",
        "Spec: exchange-spec \u00a76.3 (Step 4)."
      ],
      "discriminator": [
        95,
        129,
        237,
        240,
        8,
        49,
        223,
        132
      ],
      "accounts": [
        {
          "name": "owner",
          "docs": [
            "Order owner \u2014 only the owner can cancel (enforced by the seed below)."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "optionMint",
          "docs": [
            "Token-2022 option mint. Part of the order PDA seed."
          ],
          "writable": true
        },
        {
          "name": "order",
          "docs": [
            "The resting order being cancelled. Seed embeds owner.key(), so only the",
            "owner can derive it. Closed here; rent \u2192 owner."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  115,
                  116,
                  105,
                  110,
                  103,
                  95,
                  111,
                  114,
                  100,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "optionMint"
              },
              {
                "kind": "account",
                "path": "owner"
              },
              {
                "kind": "account",
                "path": "order.nonce",
                "account": "restingOrder"
              }
            ]
          }
        },
        {
          "name": "escrow",
          "docs": [
            "Per-order escrow PDA (option tokens for asks, USDC for bids)."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  115,
                  116,
                  105,
                  110,
                  103,
                  95,
                  111,
                  114,
                  100,
                  101,
                  114,
                  95,
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "order"
              }
            ]
          }
        },
        {
          "name": "protocolState",
          "docs": [
            "Protocol state \u2014 signs the escrow-source transfer + close."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  116,
                  111,
                  99,
                  111,
                  108,
                  95,
                  118,
                  50
                ]
              }
            ]
          }
        },
        {
          "name": "ownerOptionAccount",
          "docs": [
            "Owner's option ATA \u2014 destination on the ResaleAsk branch."
          ],
          "writable": true
        },
        {
          "name": "ownerUsdcAccount",
          "docs": [
            "Owner's USDC account \u2014 destination on the Bid branch."
          ],
          "writable": true
        },
        {
          "name": "transferHookProgram",
          "docs": [
            "Transfer hook program."
          ]
        },
        {
          "name": "extraAccountMetaList",
          "docs": [
            "ExtraAccountMetaList for the transfer hook."
          ]
        },
        {
          "name": "hookState",
          "docs": [
            "HookState for the transfer hook."
          ]
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "token2022Program",
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "cancelTrigger",
      "docs": [
        "Owner cancels their own trigger; refunds the full escrow (BUY) and closes",
        "both PDAs, rent \u2192 owner. NOT flag-gated. Spec v1 \u00a7cancel."
      ],
      "discriminator": [
        208,
        139,
        249,
        52,
        247,
        33,
        57,
        223
      ],
      "accounts": [
        {
          "name": "owner",
          "docs": [
            "Trigger owner \u2014 only the owner can cancel (enforced by the seed below)."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "triggerOrder",
          "docs": [
            "The trigger being cancelled. Seed embeds owner.key(), so only the owner",
            "can derive it. Self-references its own stored option_mint + nonce",
            "(the FillOrder self-seed idiom). Closed here; rent \u2192 owner."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  114,
                  105,
                  103,
                  103,
                  101,
                  114,
                  95,
                  111,
                  114,
                  100,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              },
              {
                "kind": "account",
                "path": "trigger_order.option_mint",
                "account": "triggerOrder"
              },
              {
                "kind": "account",
                "path": "trigger_order.nonce",
                "account": "triggerOrder"
              }
            ]
          }
        },
        {
          "name": "triggerEscrow",
          "docs": [
            "Per-trigger USDC escrow PDA (touched only when escrow_funded). On a SELL",
            "this is the derived (uninitialized) address, passed but never read."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  114,
                  105,
                  103,
                  103,
                  101,
                  114,
                  95,
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "triggerOrder"
              }
            ]
          }
        },
        {
          "name": "protocolState",
          "docs": [
            "Protocol state \u2014 signs the escrow-source refund + close."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  116,
                  111,
                  99,
                  111,
                  108,
                  95,
                  118,
                  50
                ]
              }
            ]
          }
        },
        {
          "name": "ownerUsdcAccount",
          "docs": [
            "Owner's USDC account \u2014 refund destination (BUY). Mint enforced by the SPL",
            "transfer (from.mint == to.mint); unused on the SELL branch."
          ],
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": []
    },
    {
      "name": "cancelV2Resale",
      "docs": [
        "V2 secondary listing \u2014 seller cancels their own listing.",
        "Spec: docs/V2_SECONDARY_LISTING_PLAN.md \u00a72.3."
      ],
      "discriminator": [
        3,
        116,
        67,
        205,
        76,
        179,
        4,
        254
      ],
      "accounts": [
        {
          "name": "seller",
          "docs": [
            "Seller \u2014 only the listing's seller can cancel."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "sharedVault",
          "docs": [
            "Vault \u2014 read for context (no mutation here)."
          ]
        },
        {
          "name": "optionMint",
          "docs": [
            "Token-2022 mint."
          ],
          "writable": true
        },
        {
          "name": "listing",
          "docs": [
            "Listing being cancelled. Closed at instruction end; rent \u2192 seller."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116,
                  95,
                  114,
                  101,
                  115,
                  97,
                  108,
                  101,
                  95,
                  108,
                  105,
                  115,
                  116,
                  105,
                  110,
                  103
                ]
              },
              {
                "kind": "account",
                "path": "optionMint"
              },
              {
                "kind": "account",
                "path": "seller"
              }
            ]
          }
        },
        {
          "name": "resaleEscrow",
          "docs": [
            "Resale escrow \u2014 source of the token-return transfer."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116,
                  95,
                  114,
                  101,
                  115,
                  97,
                  108,
                  101,
                  95,
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "listing"
              }
            ]
          }
        },
        {
          "name": "sellerOptionAccount",
          "docs": [
            "Seller's option ATA \u2014 destination of the returned tokens."
          ],
          "writable": true
        },
        {
          "name": "protocolState",
          "docs": [
            "Protocol state \u2014 signs the escrow-source transfer."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  116,
                  111,
                  99,
                  111,
                  108,
                  95,
                  118,
                  50
                ]
              }
            ]
          }
        },
        {
          "name": "transferHookProgram",
          "docs": [
            "Transfer hook program."
          ]
        },
        {
          "name": "extraAccountMetaList",
          "docs": [
            "ExtraAccountMetaList for the transfer hook."
          ]
        },
        {
          "name": "hookState",
          "docs": [
            "HookState for the transfer hook."
          ]
        },
        {
          "name": "token2022Program",
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "claimPremium",
      "docs": [
        "Claim earned premium from a shared vault."
      ],
      "discriminator": [
        225,
        124,
        12,
        107,
        24,
        154,
        37,
        100
      ],
      "accounts": [
        {
          "name": "writer",
          "docs": [
            "The writer claiming premium."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "sharedVault",
          "docs": [
            "The shared vault."
          ],
          "writable": true
        },
        {
          "name": "writerPosition",
          "docs": [
            "Writer's position in the vault."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  119,
                  114,
                  105,
                  116,
                  101,
                  114,
                  95,
                  112,
                  111,
                  115,
                  105,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "sharedVault"
              },
              {
                "kind": "account",
                "path": "writer"
              }
            ]
          }
        },
        {
          "name": "vaultUsdcAccount",
          "docs": [
            "Vault's USDC token account \u2014 source of premium."
          ],
          "writable": true
        },
        {
          "name": "writerUsdcAccount",
          "docs": [
            "Writer's USDC token account \u2014 destination."
          ],
          "writable": true
        },
        {
          "name": "protocolState",
          "docs": [
            "Protocol state \u2014 for USDC mint validation."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  116,
                  111,
                  99,
                  111,
                  108,
                  95,
                  118,
                  50
                ]
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "docs": [
            "Standard SPL Token program."
          ],
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": []
    },
    {
      "name": "createAndDeposit",
      "docs": [
        "Exchange Phase 2 Pass C \u2014 atomic write merge (D9). Fuses create_shared_vault",
        "+ deposit_to_vault into ONE tx via init_if_needed: the first caller for a",
        "spec creates + deposits, a subsequent caller just deposits. The heavy mint",
        "left the write path (D8/D9), so this carries no Token-2022 mint + no",
        "BS-2002. Kills the partial-flow stranded-collateral hazard structurally.",
        "Additive \u2014 create_shared_vault + deposit_to_vault stay live. EUR",
        "byte-identical; American keeps create_shared_vault's AMERICAN_ENABLED gate.",
        "Spec: \u00a77.3.3 / \u00a77.6."
      ],
      "discriminator": [
        149,
        232,
        62,
        162,
        238,
        69,
        34,
        47
      ],
      "accounts": [
        {
          "name": "writer",
          "docs": [
            "The depositor \u2014 also the creator on a fresh vault. Pays all rent."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "market",
          "docs": [
            "The OptionsMarket this vault is for."
          ]
        },
        {
          "name": "sharedVault",
          "docs": [
            "The SharedVault PDA \u2014 unique per (namespace/exercise_style, market,",
            "strike, expiry, option_type). `init_if_needed`: created on the first",
            "caller, reused on subsequent deposits into the same spec."
          ],
          "writable": true
        },
        {
          "name": "vaultUsdcAccount",
          "docs": [
            "The vault's USDC token account (authority = shared_vault PDA). Pinned by",
            "its own PDA seeds \u2014 NOT by shared_vault.vault_usdc_account, which is zero",
            "at constraint-eval time on a fresh init."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116,
                  95,
                  117,
                  115,
                  100,
                  99
                ]
              },
              {
                "kind": "account",
                "path": "sharedVault"
              }
            ]
          }
        },
        {
          "name": "usdcMint",
          "docs": [
            "USDC mint \u2014 pinned to the protocol's stored USDC mint."
          ]
        },
        {
          "name": "writerPosition",
          "docs": [
            "Writer's position \u2014 created on first deposit, accumulated thereafter."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  119,
                  114,
                  105,
                  116,
                  101,
                  114,
                  95,
                  112,
                  111,
                  115,
                  105,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "sharedVault"
              },
              {
                "kind": "account",
                "path": "writer"
              }
            ]
          }
        },
        {
          "name": "writerUsdcAccount",
          "docs": [
            "Writer's USDC account \u2014 source of collateral. Pinned to `usdc_mint`",
            "(not the vault's stored collateral_mint, which is zero on a fresh init)."
          ],
          "writable": true
        },
        {
          "name": "protocolState",
          "docs": [
            "Protocol state \u2014 USDC mint validation."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  116,
                  111,
                  99,
                  111,
                  108,
                  95,
                  118,
                  50
                ]
              }
            ]
          }
        },
        {
          "name": "epochConfig",
          "docs": [
            "Epoch config \u2014 required for Epoch vaults on fresh create, else optional."
          ],
          "optional": true
        },
        {
          "name": "tokenProgram",
          "docs": [
            "Standard SPL Token program."
          ],
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "strikePrice",
          "type": "u64"
        },
        {
          "name": "expiry",
          "type": "i64"
        },
        {
          "name": "optionType",
          "type": {
            "defined": {
              "name": "optionType"
            }
          }
        },
        {
          "name": "vaultType",
          "type": {
            "defined": {
              "name": "vaultType"
            }
          }
        },
        {
          "name": "collateralMint",
          "type": "pubkey"
        },
        {
          "name": "carryRateBps",
          "type": "i32"
        },
        {
          "name": "exerciseStyle",
          "type": {
            "defined": {
              "name": "exerciseStyle"
            }
          }
        },
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "createMarket",
      "docs": [
        "Register a supported asset (permissionless, idempotent).",
        "One Market PDA per asset; strike/expiry/type live on SharedVault.",
        "`pyth_feed_id` is the 32-byte Pyth Pull feed ID for the asset."
      ],
      "discriminator": [
        103,
        226,
        97,
        235,
        200,
        188,
        251,
        254
      ],
      "accounts": [
        {
          "name": "creator",
          "docs": [
            "Permissionless post-HIGH-5 fix (audit Run-7). Any signer pays for",
            "account creation on first init; pays nothing on idempotent re-call",
            "because `init_if_needed` short-circuits. The proof-of-feed gate is",
            "enforced via the `price_update` account (Pyth) or the trailing SB",
            "accounts (Switchboard) below."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "protocolState",
          "docs": [
            "Global ProtocolState \u2014 mutated to bump total_markets on first init."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  116,
                  111,
                  99,
                  111,
                  108,
                  95,
                  118,
                  50
                ]
              }
            ]
          }
        },
        {
          "name": "priceUpdate",
          "docs": [
            "Fresh PriceUpdateV2 from the Pyth Receiver program. The handler",
            "verifies `verification_level == Full` and",
            "`price_message.feed_id == pyth_feed_id` to prove the caller-supplied",
            "feed_id corresponds to a real Pyth feed. Read-only \u2014 never mutated.",
            "",
            "Stage 3 1c-i-B: now `Option`. REQUIRED (present) for a Pyth create",
            "(oracle_source=0) \u2014 a present account is wire-identical to the prior",
            "required form, so existing Pyth creates are unaffected. Passed None for",
            "a Switchboard create (oracle_source=1): the SB feed-existence proof runs",
            "against the trailing SB accounts instead. Pyth arm errors",
            "`PriceUpdateMissing` if absent on a Pyth create."
          ],
          "optional": true
        },
        {
          "name": "market",
          "docs": [
            "Asset registry PDA. One per supported asset."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "arg",
                "path": "assetName"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "sbQueue",
          "docs": [
            "set) in the SB arm. Not address-pinned (per-network queue)."
          ],
          "optional": true
        },
        {
          "name": "sbSlothashes",
          "docs": [
            "runtime in the SB arm."
          ],
          "optional": true
        },
        {
          "name": "sbInstructions",
          "docs": [
            "runtime in the SB arm, then scanned for the ed25519 ix index."
          ],
          "optional": true
        }
      ],
      "args": [
        {
          "name": "assetName",
          "type": "string"
        },
        {
          "name": "pythFeedId",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "assetClass",
          "type": "u8"
        },
        {
          "name": "oracleSource",
          "type": "u8"
        }
      ]
    },
    {
      "name": "createSeries",
      "docs": [
        "Exchange Phase 2 Pass A \u2014 create the canonical per-spec series mint.",
        "Permissionless, once-per-spec (series-record `init` enforces it). American",
        "only (D12). Inert until Pass B mints against it. Spec: \u00a77.3.1."
      ],
      "discriminator": [
        181,
        9,
        52,
        120,
        197,
        221,
        42,
        142
      ],
      "accounts": [
        {
          "name": "caller",
          "docs": [
            "Permissionless caller \u2014 pays the mint + record + hook-state rent."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "market",
          "docs": [
            "The OptionsMarket this series belongs to. Must exist; provides",
            "asset_name / asset_class for spec-derived metadata."
          ]
        },
        {
          "name": "protocolState",
          "docs": [
            "Protocol state \u2014 mint authority + permanent delegate for Token-2022."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  116,
                  111,
                  99,
                  111,
                  108,
                  95,
                  118,
                  50
                ]
              }
            ]
          }
        },
        {
          "name": "optionMint",
          "docs": [
            "The canonical series mint \u2014 created via CPI. PDA seeds are SPEC-ONLY",
            "(no writer, no timestamp). Idempotency comes from the series record",
            "`init` below (a second create_series reverts \"already in use\")."
          ],
          "writable": true
        },
        {
          "name": "vaultMintRecord",
          "docs": [
            "The series record \u2014 `init` enforces once-per-spec. Reuses the VaultMint",
            "shape so the Phase 1 book's mint\u2194vault proof needs zero changes (D5);",
            "per-writer fields are sentineled (see handler)."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116,
                  95,
                  109,
                  105,
                  110,
                  116,
                  95,
                  114,
                  101,
                  99,
                  111,
                  114,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "optionMint"
              }
            ]
          }
        },
        {
          "name": "transferHookProgram",
          "docs": [
            "Transfer hook program \u2014 pinned to the known opta-transfer-hook ID."
          ]
        },
        {
          "name": "extraAccountMetaList",
          "docs": [
            "ExtraAccountMetaList PDA \u2014 created by the hook program during CPI."
          ],
          "writable": true
        },
        {
          "name": "hookState",
          "docs": [
            "HookState PDA \u2014 created by the hook program during CPI."
          ],
          "writable": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "token2022Program",
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        },
        {
          "name": "rent",
          "address": "SysvarRent111111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "strike",
          "type": "u64"
        },
        {
          "name": "expiry",
          "type": "i64"
        },
        {
          "name": "optionType",
          "type": {
            "defined": {
              "name": "optionType"
            }
          }
        },
        {
          "name": "exerciseStyle",
          "type": {
            "defined": {
              "name": "exerciseStyle"
            }
          }
        }
      ]
    },
    {
      "name": "createSharedVault",
      "docs": [
        "Create a new shared collateral vault for a specific option specification."
      ],
      "discriminator": [
        152,
        55,
        207,
        92,
        82,
        162,
        20,
        84
      ],
      "accounts": [
        {
          "name": "creator",
          "docs": [
            "The vault creator (first writer). Pays for account creation."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "market",
          "docs": [
            "The OptionsMarket this vault is for. Must exist and be active."
          ]
        },
        {
          "name": "sharedVault",
          "docs": [
            "The SharedVault PDA \u2014 unique per (market, strike, expiry, option_type,",
            "exercise_style). EUR and AMER use separate seed prefixes",
            "(`b\"shared_vault\"` vs `b\"shared_vault_american\"`) so both can coexist",
            "at the same numeric tuple."
          ],
          "writable": true
        },
        {
          "name": "vaultUsdcAccount",
          "docs": [
            "The vault's USDC token account. Authority = shared_vault PDA.",
            "This holds all the collateral deposited by writers."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116,
                  95,
                  117,
                  115,
                  100,
                  99
                ]
              },
              {
                "kind": "account",
                "path": "sharedVault"
              }
            ]
          }
        },
        {
          "name": "usdcMint",
          "docs": [
            "USDC mint \u2014 validated against the protocol's stored USDC mint."
          ]
        },
        {
          "name": "protocolState",
          "docs": [
            "Protocol state \u2014 for USDC mint validation."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  116,
                  111,
                  99,
                  111,
                  108,
                  95,
                  118,
                  50
                ]
              }
            ]
          }
        },
        {
          "name": "epochConfig",
          "docs": [
            "Epoch config \u2014 required for Epoch vaults, optional for Custom.",
            "When present, used to validate the expiry aligns with the epoch schedule."
          ],
          "optional": true
        },
        {
          "name": "tokenProgram",
          "docs": [
            "Standard SPL Token program \u2014 for the USDC token account."
          ],
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "strikePrice",
          "type": "u64"
        },
        {
          "name": "expiry",
          "type": "i64"
        },
        {
          "name": "optionType",
          "type": {
            "defined": {
              "name": "optionType"
            }
          }
        },
        {
          "name": "vaultType",
          "type": {
            "defined": {
              "name": "vaultType"
            }
          }
        },
        {
          "name": "collateralMint",
          "type": "pubkey"
        },
        {
          "name": "carryRateBps",
          "type": "i32"
        },
        {
          "name": "exerciseStyle",
          "type": {
            "defined": {
              "name": "exerciseStyle"
            }
          }
        }
      ]
    },
    {
      "name": "depositToVault",
      "docs": [
        "Deposit USDC collateral into a shared vault and receive shares."
      ],
      "discriminator": [
        18,
        62,
        110,
        8,
        26,
        106,
        248,
        151
      ],
      "accounts": [
        {
          "name": "writer",
          "docs": [
            "The writer depositing collateral."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "sharedVault",
          "docs": [
            "The vault to deposit into. Must not be settled or expired."
          ],
          "writable": true
        },
        {
          "name": "writerPosition",
          "docs": [
            "Writer's position in this vault. Created on first deposit (init_if_needed)."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  119,
                  114,
                  105,
                  116,
                  101,
                  114,
                  95,
                  112,
                  111,
                  115,
                  105,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "sharedVault"
              },
              {
                "kind": "account",
                "path": "writer"
              }
            ]
          }
        },
        {
          "name": "writerUsdcAccount",
          "docs": [
            "Writer's USDC token account \u2014 source of collateral."
          ],
          "writable": true
        },
        {
          "name": "vaultUsdcAccount",
          "docs": [
            "Vault's USDC token account \u2014 destination for collateral."
          ],
          "writable": true
        },
        {
          "name": "protocolState",
          "docs": [
            "Protocol state \u2014 for USDC mint validation."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  116,
                  111,
                  99,
                  111,
                  108,
                  95,
                  118,
                  50
                ]
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "docs": [
            "Standard SPL Token program \u2014 for USDC transfers."
          ],
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "executeTrigger",
      "docs": [
        "Keeper fires a trigger. Flag-gated (6052 while AMERICAN_ENABLED=false).",
        "Re-reads a FRESH Pyth EMA in-tx (60s/200bps, mirrors exercise_american),",
        "re-checks the stored comparator (6059), then routes to the shared cores:",
        "StopEntryBuy \u2192 vault_peg_fill_core (escrow pays, mints to owner);",
        "TakeProfitSell \u2192 american_exercise_core (delegate burns, vault pays owner)",
        "with a fire-time owner/mint re-verification (6060) + partial-fire support.",
        "CALLERS MUST prepend ComputeBudgetProgram.setComputeUnitLimit(~400_000)",
        "(the BUY path runs BS-2002). Spec v1 \u00a7execute."
      ],
      "discriminator": [
        158,
        99,
        201,
        137,
        192,
        20,
        236,
        136
      ],
      "accounts": [
        {
          "name": "caller",
          "docs": [
            "Permissionless keeper \u2014 pays the tx fee. NOT the trigger owner."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "triggerOrder",
          "docs": [
            "The trigger being executed. Self-referential seeds (owner+mint+nonce are",
            "stored fields) so the keeper \u2014 not the owner \u2014 can derive it. Conditionally",
            "closed in-handler (BUY always; SELL only when fully filled)."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  114,
                  105,
                  103,
                  103,
                  101,
                  114,
                  95,
                  111,
                  114,
                  100,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "trigger_order.owner",
                "account": "triggerOrder"
              },
              {
                "kind": "account",
                "path": "trigger_order.option_mint",
                "account": "triggerOrder"
              },
              {
                "kind": "account",
                "path": "trigger_order.nonce",
                "account": "triggerOrder"
              }
            ]
          }
        },
        {
          "name": "market",
          "docs": [
            "Market \u2014 pinned to vault + trigger; provides pyth_feed_id for the EMA",
            "re-check + the vol_oracle seed."
          ]
        },
        {
          "name": "sharedVault",
          "docs": [
            "The vault \u2014 peg-fill source (BUY) / exercise-payout source (SELL)."
          ],
          "writable": true
        },
        {
          "name": "vaultMintRecord",
          "docs": [
            "Series/VaultMint record \u2014 the peg core bumps its supply counters (BUY);",
            "validated but untouched on SELL."
          ],
          "writable": true
        },
        {
          "name": "optionMint",
          "docs": [
            "The series option mint \u2014 peg mint_to target (BUY) / burn target (SELL)."
          ],
          "writable": true
        },
        {
          "name": "priceUpdate",
          "docs": [
            "Fresh PriceUpdateV2 the keeper posts in-tx. The live-EMA source for the",
            "comparator re-check (BUY+SELL) AND the intrinsic spot (SELL).",
            "",
            "Stage 3 (1a-ii): now `Option`, position unchanged. REQUIRED (present) for",
            "a Pyth market \u2014 a present price_update is wire-identical to before. A",
            "Switchboard market passes None (sentinel) and uses the trailing SB",
            "accounts. The Pyth arm errors `PriceUpdateMissing` if absent on a Pyth market."
          ],
          "optional": true
        },
        {
          "name": "volOracle",
          "docs": [
            "VolOracle for the market's feed \u2014 the BUY peg's BS-2002 input. Validated",
            "on SELL but unused."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  111,
                  108,
                  95,
                  111,
                  114,
                  97,
                  99,
                  108,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "market.pyth_feed_id",
                "account": "optionsMarket"
              }
            ]
          }
        },
        {
          "name": "protocolState",
          "docs": [
            "Protocol state \u2014 fee_bps + total_volume + mint authority (BUY), escrow",
            "authority (BUY refund/debit + close), and the PermanentDelegate burn",
            "authority (SELL)."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  116,
                  111,
                  99,
                  111,
                  108,
                  95,
                  118,
                  50
                ]
              }
            ]
          }
        },
        {
          "name": "treasury",
          "docs": [
            "Treasury \u2014 BUY fee destination. Validated but unused on SELL."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  114,
                  101,
                  97,
                  115,
                  117,
                  114,
                  121,
                  95,
                  118,
                  50
                ]
              }
            ]
          }
        },
        {
          "name": "triggerEscrow",
          "docs": [
            "Per-trigger USDC escrow (BUY): peg USDC source + unspent refund + close.",
            "SELL: the derived (uninitialized) address, never touched."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  114,
                  105,
                  103,
                  103,
                  101,
                  114,
                  95,
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "triggerOrder"
              }
            ]
          }
        },
        {
          "name": "holderOptionAta",
          "docs": [
            "The owner's option ATA stored at placement.",
            "BUY : peg mint destination (pre-created in P0).",
            "SELL: the delegate-burn source (re-verified in-handler)."
          ],
          "writable": true
        },
        {
          "name": "ownerUsdcAccount",
          "docs": [
            "Owner's USDC account \u2014 BUY: unspent-escrow refund dest; SELL: payout dest.",
            "Pinned to the trigger owner + USDC mint so a keeper can't redirect proceeds."
          ],
          "writable": true
        },
        {
          "name": "ownerWallet",
          "docs": [
            "Owner's wallet \u2014 rent destination on close (escrow + trigger_order)."
          ],
          "writable": true
        },
        {
          "name": "vaultUsdcAccount",
          "docs": [
            "Vault's USDC account \u2014 BUY vault_share destination / SELL payout source."
          ],
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "token2022Program",
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "sbQueue",
          "docs": [
            "set) in the SB arm. Not address-pinned (per-network queue)."
          ],
          "optional": true
        },
        {
          "name": "sbSlothashes",
          "docs": [
            "runtime in the SB arm."
          ],
          "optional": true
        },
        {
          "name": "sbInstructions",
          "docs": [
            "runtime in the SB arm, then scanned for the ed25519 ix index."
          ],
          "optional": true
        }
      ],
      "args": []
    },
    {
      "name": "exerciseAmerican",
      "docs": [
        "Early (pre-expiry) American exercise. The holder burns `quantity`",
        "tokens and receives cash-settled capped intrinsic in USDC from the",
        "vault (CALL/PUT capped at 1\u00d7 collateral per contract). American-only",
        "and gated off via AMERICAN_ENABLED until Stage I. Spot is read from a",
        "fresh PriceUpdateV2 the exerciser supplies. Increments the vault's",
        "early-exercise counters only; settlement nets them in Stage G."
      ],
      "discriminator": [
        241,
        75,
        206,
        124,
        107,
        254,
        131,
        81
      ],
      "accounts": [
        {
          "name": "holder",
          "docs": [
            "The option token holder exercising early."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "sharedVault",
          "docs": [
            "The (unsettled, pre-expiry) American shared vault."
          ],
          "writable": true
        },
        {
          "name": "market",
          "docs": [
            "The vault's market \u2014 provides the canonical `pyth_feed_id` the supplied",
            "price update is validated against."
          ]
        },
        {
          "name": "priceUpdate",
          "docs": [
            "Fresh PriceUpdateV2 from the Pyth Receiver (exerciser posts it in the",
            "same tx). Validated for Full verification + feed_id + confidence +",
            "freshness in the handler.",
            "",
            "Stage 3: now `Option`. REQUIRED (present) for a Pyth market \u2014 its position",
            "is unchanged (4), so a present price_update is wire-identical to before.",
            "A Switchboard market passes None (program-id sentinel) and uses the",
            "trailing SB accounts instead. The Pyth arm errors `PriceUpdateMissing` if",
            "it is absent on a Pyth market."
          ],
          "optional": true
        },
        {
          "name": "vaultMintRecord",
          "docs": [
            "Validates option_mint belongs to this vault (same guard as",
            "exercise_from_vault)."
          ]
        },
        {
          "name": "optionMint",
          "docs": [
            "The Token-2022 option mint."
          ],
          "writable": true
        },
        {
          "name": "holderOptionAccount",
          "docs": [
            "Holder's option token account (Token-2022)."
          ],
          "writable": true
        },
        {
          "name": "vaultUsdcAccount",
          "docs": [
            "Vault's USDC account \u2014 payout source."
          ],
          "writable": true
        },
        {
          "name": "holderUsdcAccount",
          "docs": [
            "Holder's USDC account \u2014 receives the cash-settled payout."
          ],
          "writable": true
        },
        {
          "name": "token2022Program",
          "docs": [
            "Token-2022 program \u2014 for burning option tokens."
          ],
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        },
        {
          "name": "tokenProgram",
          "docs": [
            "Standard SPL Token program \u2014 for the USDC transfer."
          ],
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "sbQueue",
          "docs": [
            "QuoteVerifier validates it against the quote's oracle-key set in the SB arm."
          ],
          "optional": true
        },
        {
          "name": "sbSlothashes",
          "docs": [
            "runtime in the SB arm (used by QuoteVerifier for slothash freshness)."
          ],
          "optional": true
        },
        {
          "name": "sbInstructions",
          "docs": [
            "runtime in the SB arm, then scanned for the ed25519 ix index."
          ],
          "optional": true
        }
      ],
      "args": [
        {
          "name": "quantity",
          "type": "u64"
        }
      ]
    },
    {
      "name": "exerciseFromVault",
      "docs": [
        "Exercise option tokens from a settled vault."
      ],
      "discriminator": [
        236,
        119,
        0,
        19,
        99,
        94,
        191,
        116
      ],
      "accounts": [
        {
          "name": "holder",
          "docs": [
            "The option token holder exercising their tokens."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "sharedVault",
          "docs": [
            "The settled shared vault."
          ],
          "writable": true
        },
        {
          "name": "market",
          "docs": [
            "The market \u2014 for settlement verification."
          ]
        },
        {
          "name": "vaultMintRecord"
        },
        {
          "name": "optionMint",
          "docs": [
            "The Token-2022 option mint."
          ],
          "writable": true
        },
        {
          "name": "holderOptionAccount",
          "docs": [
            "Holder's option token account (Token-2022)."
          ],
          "writable": true
        },
        {
          "name": "vaultUsdcAccount",
          "docs": [
            "Vault's USDC account \u2014 payout source."
          ],
          "writable": true
        },
        {
          "name": "holderUsdcAccount",
          "docs": [
            "Holder's USDC account \u2014 receives payout."
          ],
          "writable": true
        },
        {
          "name": "protocolState",
          "docs": [
            "Protocol state \u2014 for USDC mint validation."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  116,
                  111,
                  99,
                  111,
                  108,
                  95,
                  118,
                  50
                ]
              }
            ]
          }
        },
        {
          "name": "token2022Program",
          "docs": [
            "Token-2022 program \u2014 for burning option tokens."
          ],
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        },
        {
          "name": "tokenProgram",
          "docs": [
            "Standard SPL Token program \u2014 for USDC transfers."
          ],
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "quantity",
          "type": "u64"
        }
      ]
    },
    {
      "name": "fillOrder",
      "docs": [
        "Exchange book \u2014 taker fills a named resting order (partial fills first-class).",
        "Spec: exchange-spec \u00a76.3 (Step 3)."
      ],
      "discriminator": [
        232,
        122,
        115,
        25,
        199,
        143,
        136,
        162
      ],
      "accounts": [
        {
          "name": "taker",
          "docs": [
            "Taker \u2014 pays/receives USDC, delivers/receives option tokens."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "optionMint",
          "docs": [
            "Token-2022 option mint. Part of the order PDA seed (binds mint\u2194order)."
          ],
          "writable": true
        },
        {
          "name": "order",
          "docs": [
            "The resting order being filled. Seeds bind it to (option_mint, owner,",
            "nonce); a wrong option_mint fails derivation. Closed on full fill via",
            "the manual idiom (Anchor `close =` can't be conditional)."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  115,
                  116,
                  105,
                  110,
                  103,
                  95,
                  111,
                  114,
                  100,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "optionMint"
              },
              {
                "kind": "account",
                "path": "order.owner",
                "account": "restingOrder"
              },
              {
                "kind": "account",
                "path": "order.nonce",
                "account": "restingOrder"
              }
            ]
          }
        },
        {
          "name": "maker",
          "docs": [
            "Maker wallet \u2014 order owner. Rent destination on close, USDC recipient on",
            "a resale fill. Pinned to order.owner so no third party redirects rent."
          ],
          "writable": true
        },
        {
          "name": "sharedVault",
          "docs": [
            "Vault \u2014 read for the expiry guard."
          ]
        },
        {
          "name": "escrow",
          "docs": [
            "Per-order escrow PDA (option tokens for asks, USDC for bids)."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  115,
                  116,
                  105,
                  110,
                  103,
                  95,
                  111,
                  114,
                  100,
                  101,
                  114,
                  95,
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "order"
              }
            ]
          }
        },
        {
          "name": "protocolState",
          "docs": [
            "Protocol state \u2014 fee_bps + escrow signer authority."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  116,
                  111,
                  99,
                  111,
                  108,
                  95,
                  118,
                  50
                ]
              }
            ]
          }
        },
        {
          "name": "treasury",
          "docs": [
            "Treasury \u2014 receives the protocol fee."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  114,
                  101,
                  97,
                  115,
                  117,
                  114,
                  121,
                  95,
                  118,
                  50
                ]
              }
            ]
          }
        },
        {
          "name": "takerUsdcAccount",
          "docs": [
            "Taker's USDC ATA \u2014 source on resale fill, destination on bid fill."
          ],
          "writable": true
        },
        {
          "name": "makerUsdcAccount",
          "docs": [
            "Maker's USDC ATA \u2014 destination on resale fill (unused on bid fill, but",
            "passed for uniform context). Pinned to order.owner + USDC mint."
          ],
          "writable": true
        },
        {
          "name": "takerOptionAccount",
          "docs": [
            "Taker's option ATA \u2014 destination on resale fill, source on bid fill."
          ],
          "writable": true
        },
        {
          "name": "makerOptionAccount",
          "docs": [
            "Maker's option ATA \u2014 destination on bid fill (unused on resale fill)."
          ],
          "writable": true
        },
        {
          "name": "transferHookProgram",
          "docs": [
            "Transfer hook program."
          ]
        },
        {
          "name": "extraAccountMetaList",
          "docs": [
            "ExtraAccountMetaList for the transfer hook."
          ]
        },
        {
          "name": "hookState",
          "docs": [
            "HookState for the transfer hook."
          ]
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "token2022Program",
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "fillQuantity",
          "type": "u64"
        }
      ]
    },
    {
      "name": "fillVaultPeg",
      "docs": [
        "Exchange Phase 2 Pass B \u2014 fill the standing vault peg: price an American",
        "series at fill time (BS-2002 + spread_bps via the shared price_american",
        "helper), take USDC (pool premium + fee), and mint `quantity` contracts",
        "to the taker from pooled vault collateral. `max_premium` is the taker's",
        "fee-inclusive slippage ceiling. Dark behind AMERICAN_ENABLED until the",
        "Stage-I flip. Spec: \u00a77.3.2 (D3/D5/D6/D7)."
      ],
      "discriminator": [
        165,
        46,
        230,
        80,
        184,
        248,
        162,
        92
      ],
      "accounts": [
        {
          "name": "taker",
          "docs": [
            "The taker \u2014 pays USDC, receives freshly-minted series contracts."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "sharedVault",
          "docs": [
            "The series' shared vault \u2014 collateral pot + commitment counters + the",
            "spread_bps / voided / exercise_style fields. Mutated."
          ],
          "writable": true
        },
        {
          "name": "vaultMintRecord",
          "docs": [
            "The series record (Pass A) \u2014 the standing ask. Pins option_mint\u2194vault",
            "(mint\u2194vault proof) and carries the series supply counters."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116,
                  95,
                  109,
                  105,
                  110,
                  116,
                  95,
                  114,
                  101,
                  99,
                  111,
                  114,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "optionMint"
              }
            ]
          }
        },
        {
          "name": "market",
          "docs": [
            "Market \u2014 provides pyth_feed_id for the VolOracle seed; pinned to the vault."
          ]
        },
        {
          "name": "volOracle",
          "docs": [
            "VolOracle PDA for the market's Pyth feed \u2014 the pricing input. Read-only."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  111,
                  108,
                  95,
                  111,
                  114,
                  97,
                  99,
                  108,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "market.pyth_feed_id",
                "account": "optionsMarket"
              }
            ]
          }
        },
        {
          "name": "protocolState",
          "docs": [
            "Protocol state \u2014 fee_bps, volume, and the option mint's authority",
            "(signs mint_to with PROTOCOL_SEED). Mutated (total_volume)."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  116,
                  111,
                  99,
                  111,
                  108,
                  95,
                  118,
                  50
                ]
              }
            ]
          }
        },
        {
          "name": "optionMint",
          "docs": [
            "The canonical series mint (Token-2022) \u2014 mint_to target. Authority =",
            "protocol_state (create_series.rs:185). Pinned to the series record."
          ],
          "writable": true
        },
        {
          "name": "takerOptionAccount",
          "docs": [
            "Taker's option ATA on the series mint \u2014 mint_to destination. The client",
            "pre-creates it idempotently (no hook runs on a mint)."
          ],
          "writable": true
        },
        {
          "name": "takerUsdcAccount",
          "docs": [
            "Taker's USDC account \u2014 premium source."
          ],
          "writable": true
        },
        {
          "name": "vaultUsdcAccount",
          "docs": [
            "Vault's USDC account \u2014 receives the vault's share of premium (pool \u2014 D7)."
          ],
          "writable": true
        },
        {
          "name": "treasury",
          "docs": [
            "Treasury \u2014 receives the protocol fee."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  114,
                  101,
                  97,
                  115,
                  117,
                  114,
                  121,
                  95,
                  118,
                  50
                ]
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "docs": [
            "Standard SPL Token program \u2014 for USDC transfers."
          ],
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "token2022Program",
          "docs": [
            "Token-2022 program \u2014 for the option mint_to."
          ],
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        }
      ],
      "args": [
        {
          "name": "quantity",
          "type": "u64"
        },
        {
          "name": "maxPremium",
          "type": "u64"
        }
      ]
    },
    {
      "name": "getOptionPrice",
      "docs": [
        "AMER-only BS-2002 pricing view. Read-only; CPI-callable.",
        "Returns OptionPriceQuote (premium + vol/spot snapshot + ts) for the",
        "supplied hypothetical option against a live VolOracle. European",
        "reverts with ViewNotSupportedForEuropean \u2014 use the off-chain BS",
        "pricer (app/src/utils/blackScholes.ts) for EUR quotes. Shares the",
        "`price_american` helper with mint_from_vault, so same-block quotes",
        "match what a mint would charge."
      ],
      "discriminator": [
        233,
        38,
        28,
        199,
        162,
        22,
        173,
        25
      ],
      "accounts": [
        {
          "name": "market",
          "docs": [
            "The OptionsMarket \u2014 provides `pyth_feed_id` used as the VolOracle",
            "PDA seed. Read-only."
          ]
        },
        {
          "name": "volOracle",
          "docs": [
            "VolOracle PDA for the market's Pyth feed. Read-only.",
            "Bump derived canonically (not from stored bump) since the view has",
            "no perf-critical CU budget and avoids a load-before-account-ctx",
            "dance for an account that gets re-loaded inside the handler."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  111,
                  108,
                  95,
                  111,
                  114,
                  97,
                  99,
                  108,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "market.pyth_feed_id",
                "account": "optionsMarket"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "strike",
          "type": "u64"
        },
        {
          "name": "expiryTs",
          "type": "i64"
        },
        {
          "name": "optionType",
          "type": {
            "defined": {
              "name": "optionType"
            }
          }
        },
        {
          "name": "exerciseStyle",
          "type": {
            "defined": {
              "name": "exerciseStyle"
            }
          }
        },
        {
          "name": "carryRateBps",
          "type": "i32"
        }
      ],
      "returns": {
        "defined": {
          "name": "optionPriceQuote"
        }
      }
    },
    {
      "name": "initializeEpochConfig",
      "docs": [
        "Initialize the epoch schedule (admin-only, one-time setup)."
      ],
      "discriminator": [
        224,
        171,
        134,
        64,
        85,
        90,
        160,
        246
      ],
      "accounts": [
        {
          "name": "admin",
          "docs": [
            "Protocol admin \u2014 must match protocol_state.admin."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "protocolState",
          "docs": [
            "Protocol state \u2014 used to verify the admin."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  116,
                  111,
                  99,
                  111,
                  108,
                  95,
                  118,
                  50
                ]
              }
            ]
          }
        },
        {
          "name": "epochConfig",
          "docs": [
            "The epoch config PDA \u2014 created once, never recreated."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  112,
                  111,
                  99,
                  104,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "weeklyExpiryDay",
          "type": "u8"
        },
        {
          "name": "weeklyExpiryHour",
          "type": "u8"
        },
        {
          "name": "monthlyEnabled",
          "type": "bool"
        }
      ]
    },
    {
      "name": "initializeProtocol",
      "discriminator": [
        188,
        233,
        252,
        106,
        134,
        146,
        202,
        91
      ],
      "accounts": [
        {
          "name": "admin",
          "docs": [
            "The admin who is initializing the protocol. They pay for account rent",
            "and become the protocol admin."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "protocolState",
          "docs": [
            "ProtocolState PDA \u2014 the global config singleton.",
            "`init` means Anchor will create this account. If it already exists,",
            "the transaction fails (preventing double-initialization)."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  116,
                  111,
                  99,
                  111,
                  108,
                  95,
                  118,
                  50
                ]
              }
            ]
          }
        },
        {
          "name": "treasury",
          "docs": [
            "Treasury \u2014 a USDC token account owned by the protocol PDA.",
            "This is where protocol fees accumulate."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  114,
                  101,
                  97,
                  115,
                  117,
                  114,
                  121,
                  95,
                  118,
                  50
                ]
              }
            ]
          }
        },
        {
          "name": "usdcMint",
          "docs": [
            "The USDC mint account. On devnet, this is a test mint."
          ]
        },
        {
          "name": "systemProgram",
          "docs": [
            "Required system programs for account creation."
          ],
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "rent",
          "address": "SysvarRent111111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "initializeVolOracle",
      "docs": [
        "Bootstrap a per-feed VolOracle PDA. Permissionless; caller supplies",
        "a fresh PriceUpdateV2 whose feed_id matches the arg as proof-of-",
        "feed-existence. Plain `init` -- second call for the same feed_id",
        "reverts."
      ],
      "discriminator": [
        56,
        31,
        16,
        133,
        209,
        199,
        81,
        66
      ],
      "accounts": [
        {
          "name": "initializer",
          "docs": [
            "Permissionless. Any signer pays for account creation."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "priceUpdate",
          "docs": [
            "Fresh PriceUpdateV2 from the Pyth Receiver program. REQUIRED (present)",
            "for a Pyth oracle (oracle_source=0): the handler reads its CURRENT spot",
            "via `pyth_current_spot_scale` to seed `last_spot_price` AND proves feed",
            "existence (verification_level == Full + feed_id match) in the same call.",
            "Read-only -- never mutated. Passed None for a Switchboard oracle",
            "(oracle_source=1): spot is seeded from the SB quote instead. The Pyth arm",
            "errors `PriceUpdateMissing` if absent on a Pyth init."
          ],
          "optional": true
        },
        {
          "name": "volOracle",
          "docs": [
            "The VolOracle PDA. One per Pyth feed_id. Plain `init` -- a second",
            "call for the same feed_id reverts (\"account already in use\").",
            "`AccountLoader` (not `Account`) because zero_copy: see state file."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  111,
                  108,
                  95,
                  111,
                  114,
                  97,
                  99,
                  108,
                  101
                ]
              },
              {
                "kind": "arg",
                "path": "feedId"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "sbQueue",
          "docs": [
            "set) in the SB arm. Not address-pinned (per-network queue)."
          ],
          "optional": true
        },
        {
          "name": "sbSlothashes",
          "docs": [
            "runtime in the SB arm."
          ],
          "optional": true
        },
        {
          "name": "sbInstructions",
          "docs": [
            "runtime in the SB arm, then scanned for the ed25519 ix index."
          ],
          "optional": true
        }
      ],
      "args": [
        {
          "name": "feedId",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "oracleSource",
          "type": "u8"
        },
        {
          "name": "seedVol",
          "type": "i64"
        }
      ]
    },
    {
      "name": "listV2ForResale",
      "docs": [
        "V2 secondary listing \u2014 list option tokens for resale.",
        "Spec: docs/V2_SECONDARY_LISTING_PLAN.md \u00a72.1."
      ],
      "discriminator": [
        61,
        108,
        196,
        219,
        154,
        142,
        41,
        201
      ],
      "accounts": [
        {
          "name": "seller",
          "docs": [
            "Seller \u2014 listing creator. Pays for listing PDA + escrow rent."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "sharedVault",
          "docs": [
            "The vault this option mint was minted from."
          ]
        },
        {
          "name": "market",
          "docs": [
            "Market \u2014 pinned to the vault for sanity."
          ]
        },
        {
          "name": "vaultMintRecord",
          "docs": [
            "VaultMint record \u2014 pins option_mint to this vault."
          ]
        },
        {
          "name": "optionMint",
          "docs": [
            "Token-2022 mint being resold."
          ],
          "writable": true
        },
        {
          "name": "sellerOptionAccount",
          "docs": [
            "Seller's option ATA \u2014 source of the listing transfer."
          ],
          "writable": true
        },
        {
          "name": "listing",
          "docs": [
            "Listing PDA \u2014 initialized in this instruction. One per (mint, seller)."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116,
                  95,
                  114,
                  101,
                  115,
                  97,
                  108,
                  101,
                  95,
                  108,
                  105,
                  115,
                  116,
                  105,
                  110,
                  103
                ]
              },
              {
                "kind": "account",
                "path": "optionMint"
              },
              {
                "kind": "account",
                "path": "seller"
              }
            ]
          }
        },
        {
          "name": "resaleEscrow",
          "docs": [
            "Resale escrow Token-2022 account. Owned by protocol_state PDA.",
            "Created in handler via system_instruction + initialize_account3."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116,
                  95,
                  114,
                  101,
                  115,
                  97,
                  108,
                  101,
                  95,
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "listing"
              }
            ]
          }
        },
        {
          "name": "protocolState",
          "docs": [
            "Protocol state \u2014 escrow's owner authority."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  116,
                  111,
                  99,
                  111,
                  108,
                  95,
                  118,
                  50
                ]
              }
            ]
          }
        },
        {
          "name": "transferHookProgram",
          "docs": [
            "Transfer hook program \u2014 pinned to the known opta-transfer-hook ID."
          ]
        },
        {
          "name": "extraAccountMetaList",
          "docs": [
            "ExtraAccountMetaList for the transfer hook."
          ]
        },
        {
          "name": "hookState",
          "docs": [
            "HookState for the transfer hook."
          ]
        },
        {
          "name": "token2022Program",
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "rent",
          "address": "SysvarRent111111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "pricePerContract",
          "type": "u64"
        },
        {
          "name": "quantity",
          "type": "u64"
        }
      ]
    },
    {
      "name": "migrateMarketOracleSource",
      "docs": [
        "One-time OptionsMarket schema migration that adds the trailing",
        "oracle_source byte (Switchboard Stage 2) to pre-Stage-2 markets.",
        "Admin-only. Caller passes market accounts via remaining_accounts",
        "(BATCH_SIZE 20; the full current set of 16 fits one call). Idempotent:",
        "markets already at the new size (incl. the larger pre-reshape orphans)",
        "are skipped. Admin pays the rent delta. Sets oracle_source = 0 (Pyth)."
      ],
      "discriminator": [
        216,
        115,
        46,
        64,
        31,
        127,
        103,
        246
      ],
      "accounts": [
        {
          "name": "admin",
          "docs": [
            "Admin -- must match protocol_state.admin (CRIT-3 deployer pubkey).",
            "Pays the rent delta for any grown markets."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "protocolState",
          "docs": [
            "Used only to assert admin == protocol_state.admin."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  116,
                  111,
                  99,
                  111,
                  108,
                  95,
                  118,
                  50
                ]
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "migratePythFeed",
      "docs": [
        "Rotate the Pyth Pull feed_id stored on an existing OptionsMarket.",
        "Admin-only; idempotent on same feed_id; overwrites on different.",
        "No oracle call \u2014 only mutates registry metadata."
      ],
      "discriminator": [
        30,
        207,
        203,
        67,
        14,
        109,
        162,
        226
      ],
      "accounts": [
        {
          "name": "admin",
          "docs": [
            "Must match `protocol_state.admin`. Verified in the handler."
          ],
          "signer": true
        },
        {
          "name": "protocolState",
          "docs": [
            "Global ProtocolState \u2014 read-only here, used to verify the admin key."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  116,
                  111,
                  99,
                  111,
                  108,
                  95,
                  118,
                  50
                ]
              }
            ]
          }
        },
        {
          "name": "priceUpdate",
          "docs": [
            "Fresh PriceUpdateV2 from the Pyth Receiver program. The handler",
            "verifies `verification_level == Full` and",
            "`price_message.feed_id == new_pyth_feed_id` to prove the rotation",
            "target corresponds to a real Pyth feed. Read-only \u2014 never mutated."
          ]
        },
        {
          "name": "market",
          "docs": [
            "The market whose Pyth feed_id is being rotated. PDA seeds enforce",
            "existence \u2014 passing an unknown asset_name fails seed validation",
            "(AccountNotInitialized)."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "arg",
                "path": "assetName"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "assetName",
          "type": "string"
        },
        {
          "name": "newPythFeedId",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        }
      ]
    },
    {
      "name": "migrateSharedVaultCarryRate",
      "docs": [
        "One-time SharedVault schema migration that adds the trailing",
        "carry_rate_bps field to pre-Stage-A vaults. Admin-only. Caller passes",
        "vault accounts to migrate via remaining_accounts (recommended batch:",
        "20-30 per call to stay under 1.4M CU). Idempotent: vaults already at",
        "the new size are skipped. Admin pays the rent delta."
      ],
      "discriminator": [
        0,
        7,
        109,
        21,
        112,
        209,
        61,
        34
      ],
      "accounts": [
        {
          "name": "admin",
          "docs": [
            "Admin -- must match protocol_state.admin (CRIT-3 deployer pubkey).",
            "Pays the rent delta for any grown vaults."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "protocolState",
          "docs": [
            "Used only to assert admin == protocol_state.admin."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  116,
                  111,
                  99,
                  111,
                  108,
                  95,
                  118,
                  50
                ]
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "migrateSharedVaultExchangeFields",
      "docs": [
        "Phase 2 Pass A \u2014 one-time SharedVault schema migration adding the trailing",
        "`spread_bps` (u16) + `voided` (bool) fields. Admin-only, batched via",
        "remaining_accounts (recommended batch: 20). Idempotent: vaults already at",
        "the new 260-byte size are skipped. Zero-fill on the new 3 bytes",
        "deserializes as spread_bps=0 / voided=false. Admin pays the rent delta."
      ],
      "discriminator": [
        97,
        21,
        74,
        35,
        52,
        228,
        58,
        9
      ],
      "accounts": [
        {
          "name": "admin",
          "docs": [
            "Admin -- must match protocol_state.admin (CRIT-3 deployer pubkey).",
            "Pays the rent delta for any grown vaults."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "protocolState",
          "docs": [
            "Used only to assert admin == protocol_state.admin."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  116,
                  111,
                  99,
                  111,
                  108,
                  95,
                  118,
                  50
                ]
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "migrateSharedVaultExerciseStyle",
      "docs": [
        "One-time SharedVault schema migration that adds the trailing",
        "exercise_style field to pre-Pass-1 vaults. Admin-only.",
        "Caller passes vault accounts via remaining_accounts (recommended",
        "batch: 20-30 per call). Idempotent: vaults already at the new",
        "size are skipped. Zero-fill on the new byte deserializes as",
        "ExerciseStyle::European (variant 0). Admin pays the rent delta."
      ],
      "discriminator": [
        162,
        61,
        8,
        235,
        197,
        20,
        99,
        193
      ],
      "accounts": [
        {
          "name": "admin",
          "docs": [
            "Admin -- must match protocol_state.admin (CRIT-3 deployer pubkey).",
            "Pays the rent delta for any grown vaults."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "protocolState",
          "docs": [
            "Used only to assert admin == protocol_state.admin."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  116,
                  111,
                  99,
                  111,
                  108,
                  95,
                  118,
                  50
                ]
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "migrateSharedVaultExerciseTracking",
      "docs": [
        "One-time SharedVault schema migration that adds the trailing",
        "exercised_options + early_exercise_payout fields (Stage F) to",
        "pre-Stage-F vaults. Admin-only. Caller passes vault accounts via",
        "remaining_accounts (recommended batch: 20 per call). Idempotent:",
        "vaults already at the new size are skipped. Zero-fill on the new 16",
        "bytes deserializes as 0/0 (no early exercises). Admin pays the rent delta."
      ],
      "discriminator": [
        175,
        112,
        143,
        170,
        148,
        99,
        73,
        249
      ],
      "accounts": [
        {
          "name": "admin",
          "docs": [
            "Admin -- must match protocol_state.admin (CRIT-3 deployer pubkey).",
            "Pays the rent delta for any grown vaults."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "protocolState",
          "docs": [
            "Used only to assert admin == protocol_state.admin."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  116,
                  111,
                  99,
                  111,
                  108,
                  95,
                  118,
                  50
                ]
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "mintFromVault",
      "docs": [
        "Mint Living Option Tokens from a shared vault using writer's collateral share."
      ],
      "discriminator": [
        233,
        68,
        207,
        77,
        60,
        175,
        102,
        132
      ],
      "accounts": [
        {
          "name": "writer",
          "docs": [
            "The writer minting option tokens."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "sharedVault",
          "docs": [
            "The shared vault providing collateral backing."
          ],
          "writable": true
        },
        {
          "name": "writerPosition",
          "docs": [
            "Writer's position in the vault \u2014 validates ownership and available collateral."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  119,
                  114,
                  105,
                  116,
                  101,
                  114,
                  95,
                  112,
                  111,
                  115,
                  105,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "sharedVault"
              },
              {
                "kind": "account",
                "path": "writer"
              }
            ]
          }
        },
        {
          "name": "market",
          "docs": [
            "The OptionsMarket \u2014 for strike price, expiry, asset info in metadata."
          ]
        },
        {
          "name": "volOracle",
          "docs": [
            "VolOracle PDA for the market's Pyth feed.",
            "",
            "REQUIRED on both European and American mints (uniform-context pattern",
            "\u2014 no `Option<>`). The handler reads it only on the American branch;",
            "EUR mints carry the account but never touch it. Rationale: avoids",
            "Anchor's `Option<AccountLoader>` friction and keeps the instruction",
            "signature uniform across both styles. Caveat: any market whose",
            "VolOracle PDA hasn't been initialized yet cannot be minted from \u2014",
            "Step 2's deploy sequencing must ensure all live markets have a",
            "seeded oracle (sweep before IDL update)."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  111,
                  108,
                  95,
                  111,
                  114,
                  97,
                  99,
                  108,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "market.pyth_feed_id",
                "account": "optionsMarket"
              }
            ]
          }
        },
        {
          "name": "protocolState",
          "docs": [
            "Protocol state \u2014 mint authority and permanent delegate for Token-2022."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  116,
                  111,
                  99,
                  111,
                  108,
                  95,
                  118,
                  50
                ]
              }
            ]
          }
        },
        {
          "name": "optionMint",
          "docs": [
            "Token-2022 mint for the option tokens \u2014 created manually via CPI."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116,
                  95,
                  111,
                  112,
                  116,
                  105,
                  111,
                  110,
                  95,
                  109,
                  105,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "sharedVault"
              },
              {
                "kind": "account",
                "path": "writer"
              },
              {
                "kind": "arg",
                "path": "createdAt"
              }
            ]
          }
        },
        {
          "name": "purchaseEscrow",
          "docs": [
            "Purchase escrow \u2014 holds minted tokens until buyers purchase."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116,
                  95,
                  112,
                  117,
                  114,
                  99,
                  104,
                  97,
                  115,
                  101,
                  95,
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "sharedVault"
              },
              {
                "kind": "account",
                "path": "writer"
              },
              {
                "kind": "arg",
                "path": "createdAt"
              }
            ]
          }
        },
        {
          "name": "vaultMintRecord",
          "docs": [
            "VaultMint record \u2014 tracks premium, quantity, and sold count per mint."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116,
                  95,
                  109,
                  105,
                  110,
                  116,
                  95,
                  114,
                  101,
                  99,
                  111,
                  114,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "optionMint"
              }
            ]
          }
        },
        {
          "name": "transferHookProgram",
          "docs": [
            "The transfer hook program \u2014 for initializing hook state."
          ]
        },
        {
          "name": "extraAccountMetaList",
          "docs": [
            "ExtraAccountMetaList PDA \u2014 created by the hook program during CPI."
          ],
          "writable": true
        },
        {
          "name": "hookState",
          "docs": [
            "HookState PDA \u2014 stores expiry + protocol PDA for the transfer hook."
          ],
          "writable": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "token2022Program",
          "docs": [
            "Token-2022 program \u2014 for the option mint and token accounts."
          ],
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        },
        {
          "name": "rent",
          "address": "SysvarRent111111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "quantity",
          "type": "u64"
        },
        {
          "name": "premiumPerContract",
          "type": "u64"
        },
        {
          "name": "createdAt",
          "type": "i64"
        }
      ]
    },
    {
      "name": "placeTrigger",
      "docs": [
        "Stage a durable trigger order. NOT flag-gated (a user can stage/cancel",
        "anytime; only the Pass-1 execute path checks AMERICAN_ENABLED).",
        "StopEntryBuy escrows `max_premium \u00d7 quantity` USDC + pre-creates the",
        "owner's destination option ATA; TakeProfitSell escrows nothing and",
        "sanity-checks the declared source ATA holds \u2265 quantity. Spec v1 \u00a7placement."
      ],
      "discriminator": [
        219,
        75,
        198,
        172,
        87,
        232,
        205,
        21
      ],
      "accounts": [
        {
          "name": "owner",
          "docs": [
            "Trigger owner \u2014 pays the trigger PDA + (BUY) escrow + dest-ATA rent, and",
            "signs the inbound USDC transfer on the BUY branch."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "market",
          "docs": [
            "Market \u2014 pinned to the vault; provides pyth_feed_id for the P1 re-check."
          ]
        },
        {
          "name": "sharedVault",
          "docs": [
            "The SharedVault: peg-fill source (BUY) / exercise-payout source (SELL)."
          ]
        },
        {
          "name": "vaultMintRecord",
          "docs": [
            "Series/VaultMint record \u2014 pins option_mint\u2194vault (the mint\u2194vault proof,",
            "mirrors fill_vault_peg.rs:302-308 / exercise_american.rs:220-224)."
          ]
        },
        {
          "name": "optionMint",
          "docs": [
            "The Token-2022 option (series) mint this trigger trades. Part of the PDA",
            "seed; pinned via vault_mint_record."
          ]
        },
        {
          "name": "triggerOrder",
          "docs": [
            "The TriggerOrder PDA \u2014 created here. One per (owner, option_mint, nonce)."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  114,
                  105,
                  103,
                  103,
                  101,
                  114,
                  95,
                  111,
                  114,
                  100,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              },
              {
                "kind": "account",
                "path": "optionMint"
              },
              {
                "kind": "arg",
                "path": "nonce"
              }
            ]
          }
        },
        {
          "name": "triggerEscrow",
          "docs": [
            "Per-trigger USDC escrow PDA (BUY only), owner = protocol_state. Created",
            "in-handler via raw CPI on the BUY branch; on the SELL branch this is the",
            "derived (uninitialized) address and is never touched."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  114,
                  105,
                  103,
                  103,
                  101,
                  114,
                  95,
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "triggerOrder"
              }
            ]
          }
        },
        {
          "name": "protocolState",
          "docs": [
            "Protocol state \u2014 escrow's owner authority + canonical USDC mint pin."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  116,
                  111,
                  99,
                  111,
                  108,
                  95,
                  118,
                  50
                ]
              }
            ]
          }
        },
        {
          "name": "usdcMint",
          "docs": [
            "Canonical USDC mint \u2014 used to init the BUY escrow; pinned to protocol_state."
          ]
        },
        {
          "name": "ownerUsdcAccount",
          "docs": [
            "Owner's USDC account \u2014 BUY escrow source (unused on the SELL branch).",
            "owner by the owner signature."
          ],
          "writable": true
        },
        {
          "name": "ownerOptionAta",
          "docs": [
            "Owner's option ATA on `option_mint`.",
            "BUY : the mint destination \u2014 pre-created idempotently here.",
            "SELL: the existing source to delegate-burn at fire \u2014 read for sanity.",
            "mint/owner/balance validated from raw bytes in the handler."
          ],
          "writable": true
        },
        {
          "name": "tokenProgram",
          "docs": [
            "Classic SPL Token program \u2014 BUY escrow create/init + USDC transfer."
          ],
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "token2022Program",
          "docs": [
            "Token-2022 program \u2014 destination ATA creation (BUY)."
          ],
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        },
        {
          "name": "associatedTokenProgram",
          "docs": [
            "Associated-token program \u2014 idempotent dest-ATA create (BUY)."
          ],
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "rent",
          "address": "SysvarRent111111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "kind",
          "type": {
            "defined": {
              "name": "triggerKind"
            }
          }
        },
        {
          "name": "comparator",
          "type": {
            "defined": {
              "name": "comparator"
            }
          }
        },
        {
          "name": "thresholdUsdc",
          "type": "u64"
        },
        {
          "name": "quantity",
          "type": "u64"
        },
        {
          "name": "maxPremium",
          "type": "u64"
        },
        {
          "name": "nonce",
          "type": "u64"
        }
      ]
    },
    {
      "name": "postOrder",
      "docs": [
        "Exchange book \u2014 post a resting bid or ask (collateral escrowed per-order).",
        "Spec: exchange-spec \u00a76.3 (Step 2)."
      ],
      "discriminator": [
        241,
        172,
        254,
        140,
        77,
        72,
        246,
        132
      ],
      "accounts": [
        {
          "name": "owner",
          "docs": [
            "Order owner \u2014 pays for the order PDA + escrow rent, signs the inbound",
            "collateral transfer."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "sharedVault",
          "docs": [
            "The vault the option mint belongs to. Read for expiry / settled guards."
          ]
        },
        {
          "name": "market",
          "docs": [
            "Market \u2014 pinned to the vault for sanity."
          ]
        },
        {
          "name": "vaultMintRecord",
          "docs": [
            "VaultMint record \u2014 pins option_mint to this vault (mint\u2194vault proof,",
            "same constraint set as buy_v2_resale.rs:208-215)."
          ]
        },
        {
          "name": "optionMint",
          "docs": [
            "Token-2022 option mint being traded."
          ],
          "writable": true
        },
        {
          "name": "order",
          "docs": [
            "The RestingOrder PDA \u2014 created here. One per (option_mint, owner, nonce)."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  115,
                  116,
                  105,
                  110,
                  103,
                  95,
                  111,
                  114,
                  100,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "optionMint"
              },
              {
                "kind": "account",
                "path": "owner"
              },
              {
                "kind": "arg",
                "path": "nonce"
              }
            ]
          }
        },
        {
          "name": "escrow",
          "docs": [
            "Per-order escrow PDA, owner = protocol_state. Token-2022 for asks, classic",
            "USDC for bids \u2014 created in-handler via raw CPI."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  115,
                  116,
                  105,
                  110,
                  103,
                  95,
                  111,
                  114,
                  100,
                  101,
                  114,
                  95,
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "order"
              }
            ]
          }
        },
        {
          "name": "protocolState",
          "docs": [
            "Protocol state \u2014 escrow's owner authority + canonical USDC mint pin."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  116,
                  111,
                  99,
                  111,
                  108,
                  95,
                  118,
                  50
                ]
              }
            ]
          }
        },
        {
          "name": "ownerOptionAccount",
          "docs": [
            "Owner's option ATA \u2014 source on the ResaleAsk branch (unused for Bid)."
          ],
          "writable": true
        },
        {
          "name": "ownerUsdcAccount",
          "docs": [
            "Owner's USDC account \u2014 source on the Bid branch (unused for ResaleAsk).",
            "the owner signature."
          ],
          "writable": true
        },
        {
          "name": "usdcMint",
          "docs": [
            "Canonical USDC mint \u2014 used to init the Bid escrow; pinned to protocol_state."
          ]
        },
        {
          "name": "transferHookProgram",
          "docs": [
            "Transfer hook program \u2014 pinned to the known opta-transfer-hook ID."
          ]
        },
        {
          "name": "extraAccountMetaList",
          "docs": [
            "ExtraAccountMetaList for the transfer hook."
          ]
        },
        {
          "name": "hookState",
          "docs": [
            "HookState for the transfer hook."
          ]
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "token2022Program",
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "rent",
          "address": "SysvarRent111111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "kind",
          "type": {
            "defined": {
              "name": "orderKind"
            }
          }
        },
        {
          "name": "pricePerContract",
          "type": "u64"
        },
        {
          "name": "quantity",
          "type": "u64"
        },
        {
          "name": "nonce",
          "type": "u64"
        }
      ]
    },
    {
      "name": "purchaseFromVault",
      "docs": [
        "Purchase option tokens minted from a shared vault."
      ],
      "discriminator": [
        155,
        113,
        57,
        45,
        72,
        199,
        72,
        29
      ],
      "accounts": [
        {
          "name": "buyer",
          "docs": [
            "The buyer purchasing option tokens."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "sharedVault",
          "docs": [
            "The shared vault this purchase is from."
          ],
          "writable": true
        },
        {
          "name": "writerPosition",
          "docs": [
            "The writer's position \u2014 for tracking options_sold."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  119,
                  114,
                  105,
                  116,
                  101,
                  114,
                  95,
                  112,
                  111,
                  115,
                  105,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "sharedVault"
              },
              {
                "kind": "account",
                "path": "vault_mint_record.writer",
                "account": "vaultMint"
              }
            ]
          }
        },
        {
          "name": "vaultMintRecord",
          "docs": [
            "VaultMint record \u2014 holds premium_per_contract and quantity tracking."
          ],
          "writable": true
        },
        {
          "name": "protocolState",
          "docs": [
            "Protocol state \u2014 for fee_bps, volume tracking, and token transfer signing."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  116,
                  111,
                  99,
                  111,
                  108,
                  95,
                  118,
                  50
                ]
              }
            ]
          }
        },
        {
          "name": "market",
          "docs": [
            "The OptionsMarket \u2014 for expiry validation."
          ]
        },
        {
          "name": "optionMint",
          "docs": [
            "Option token mint (Token-2022)."
          ]
        },
        {
          "name": "purchaseEscrow",
          "docs": [
            "Purchase escrow holding unsold tokens (Token-2022 account)."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116,
                  95,
                  112,
                  117,
                  114,
                  99,
                  104,
                  97,
                  115,
                  101,
                  95,
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "sharedVault"
              },
              {
                "kind": "account",
                "path": "vault_mint_record.writer",
                "account": "vaultMint"
              },
              {
                "kind": "account",
                "path": "vault_mint_record.created_at",
                "account": "vaultMint"
              }
            ]
          }
        },
        {
          "name": "buyerOptionAccount",
          "docs": [
            "Buyer's option token account (Token-2022). Frontend creates ATA before calling."
          ],
          "writable": true
        },
        {
          "name": "buyerUsdcAccount",
          "docs": [
            "Buyer's USDC account \u2014 pays premium from here."
          ],
          "writable": true
        },
        {
          "name": "vaultUsdcAccount",
          "docs": [
            "Vault's USDC account \u2014 receives writer's share of premium."
          ],
          "writable": true
        },
        {
          "name": "treasury",
          "docs": [
            "Treasury \u2014 receives protocol fee."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  114,
                  101,
                  97,
                  115,
                  117,
                  114,
                  121,
                  95,
                  118,
                  50
                ]
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "docs": [
            "Standard SPL Token program \u2014 for USDC transfers."
          ],
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "token2022Program",
          "docs": [
            "Token-2022 program \u2014 for option token transfers."
          ],
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        },
        {
          "name": "transferHookProgram",
          "docs": [
            "Transfer hook program."
          ]
        },
        {
          "name": "extraAccountMetaList",
          "docs": [
            "ExtraAccountMetaList for the transfer hook."
          ]
        },
        {
          "name": "hookState",
          "docs": [
            "HookState with expiry info for the transfer hook."
          ]
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "quantity",
          "type": "u64"
        },
        {
          "name": "maxPremium",
          "type": "u64"
        }
      ]
    },
    {
      "name": "pushVolSample",
      "docs": [
        "Push a fresh Pyth spot sample to a VolOracle. Permissionless. The",
        "handler validates the Pyth update, computes a log return against",
        "the prior spot, and updates the ring buffer + O(1) accumulators.",
        "First push to a fresh oracle takes the seed-only branch (no",
        "ring/accumulator write; rate limit skipped). Subsequent pushes",
        "enforce the rate limit (55 min production / 1 sec test-fast-vol)."
      ],
      "discriminator": [
        14,
        178,
        211,
        15,
        69,
        245,
        145,
        31
      ],
      "accounts": [
        {
          "name": "signer",
          "docs": [
            "Permissionless. Pays the tx fee only."
          ],
          "signer": true
        },
        {
          "name": "priceUpdate",
          "docs": [
            "Fresh PriceUpdateV2 from the Pyth Receiver program. Validated",
            "against the oracle's feed_id and the 60s freshness window.",
            "",
            "Stage 3 (1a-iii): now `Option`, position unchanged. REQUIRED (present)",
            "for a Pyth-sourced oracle. A Switchboard-sourced oracle passes None",
            "(sentinel) and uses the trailing SB accounts. The Pyth arm errors",
            "`PriceUpdateMissing` if absent on a Pyth oracle."
          ],
          "optional": true
        },
        {
          "name": "volOracle",
          "docs": [
            "The VolOracle PDA. Mutated. PDA-validated against the price",
            "update's feed_id via the `seeds` constraint here; the handler",
            "re-checks the proof against price_update.price_message.feed_id",
            "for defense-in-depth against passing a stale PriceUpdateV2 from",
            "a different feed."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  111,
                  108,
                  95,
                  111,
                  114,
                  97,
                  99,
                  108,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "volOracle"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "sbQueue",
          "docs": [
            "set) in the SB arm. Not address-pinned (per-network queue)."
          ],
          "optional": true
        },
        {
          "name": "sbSlothashes",
          "docs": [
            "runtime in the SB arm."
          ],
          "optional": true
        },
        {
          "name": "sbInstructions",
          "docs": [
            "runtime in the SB arm, then scanned for the ed25519 ix index."
          ],
          "optional": true
        }
      ],
      "args": []
    },
    {
      "name": "reclaimUnsettled",
      "docs": [
        "Phase 2 Pass D \u2014 dead-feed safety hatch. Permissionless. Lets writers",
        "reclaim pooled collateral pro-rata from a vault whose settlement price",
        "NEVER landed (no SettlementRecord for its (asset, expiry)) once the 7-day",
        "GRACE_WINDOW past expiry has elapsed. Per-writer claim (one WriterPosition",
        "per call; cranker may call on a writer's behalf). Sets `voided = true` on",
        "the first call; NEVER sets `is_settled` and NEVER writes a SettlementRecord",
        "(invariant #6 \u2014 a voided vault pays holders nothing). NOT gated by",
        "AMERICAN_ENABLED: the exit path stays open regardless of the flag."
      ],
      "discriminator": [
        197,
        151,
        116,
        203,
        177,
        170,
        107,
        63
      ],
      "accounts": [
        {
          "name": "cranker",
          "docs": [
            "Permissionless cranker \u2014 pays the transaction. May reclaim on any",
            "writer's behalf; the payout always lands in the writer's USDC ATA."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "writer",
          "docs": [
            "The writer whose collateral is being reclaimed. NOT a signer \u2014 bound by",
            "the writer_position seed + the writer_usdc owner constraint.",
            "written, never required to sign."
          ]
        },
        {
          "name": "sharedVault",
          "docs": [
            "The vault being wound down via the hatch."
          ],
          "writable": true
        },
        {
          "name": "writerPosition",
          "docs": [
            "The writer's position in the vault. Zeroed (not closed) after payout."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  119,
                  114,
                  105,
                  116,
                  101,
                  114,
                  95,
                  112,
                  111,
                  115,
                  105,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "sharedVault"
              },
              {
                "kind": "account",
                "path": "writer"
              }
            ]
          }
        },
        {
          "name": "market",
          "docs": [
            "The vault's market \u2014 needed to derive the SettlementRecord PDA from",
            "`market.asset_name`. Pinned to the vault's recorded market."
          ]
        },
        {
          "name": "settlementRecord",
          "docs": [
            "The per-(asset, expiry) SettlementRecord \u2014 which MUST NOT exist for the",
            "hatch to open. Seeds-constrained so the caller cannot substitute an",
            "arbitrary empty account; the handler asserts it is empty.",
            "derived PDA; the handler requires `data_is_empty()`."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  101,
                  116,
                  116,
                  108,
                  101,
                  109,
                  101,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market.asset_name",
                "account": "optionsMarket"
              },
              {
                "kind": "account",
                "path": "shared_vault.expiry",
                "account": "sharedVault"
              }
            ]
          }
        },
        {
          "name": "vaultUsdcAccount",
          "docs": [
            "Vault's USDC token account \u2014 source of the pro-rata payout."
          ],
          "writable": true
        },
        {
          "name": "writerUsdcAccount",
          "docs": [
            "Writer's USDC token account \u2014 destination. Must be owned by the writer."
          ],
          "writable": true
        },
        {
          "name": "tokenProgram",
          "docs": [
            "Standard SPL Token program."
          ],
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": []
    },
    {
      "name": "resetVolOracle",
      "docs": [
        "Admin-only reset of a polluted/broken VolOracle. Zeroes the ring,",
        "both accumulators, sample_count, head, and last_spot/last_ts so the",
        "next push takes the seed branch (records spot, no return) and the",
        "7-day warmup re-engages from 0. feed_id (the PDA seed + Pyth identity)",
        "is preserved. One oracle per call."
      ],
      "discriminator": [
        246,
        214,
        198,
        160,
        62,
        246,
        80,
        116
      ],
      "accounts": [
        {
          "name": "admin",
          "docs": [
            "Admin -- must match protocol_state.admin (same gate as migrate_*)."
          ],
          "signer": true
        },
        {
          "name": "protocolState",
          "docs": [
            "Used only to assert admin == protocol_state.admin."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  116,
                  111,
                  99,
                  111,
                  108,
                  95,
                  118,
                  50
                ]
              }
            ]
          }
        },
        {
          "name": "volOracle",
          "docs": [
            "The VolOracle PDA to reset, derived from `feed_id` (same seeds as",
            "initialize_vol_oracle). Mutated."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  111,
                  108,
                  95,
                  111,
                  114,
                  97,
                  99,
                  108,
                  101
                ]
              },
              {
                "kind": "arg",
                "path": "feedId"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "feedId",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        }
      ]
    },
    {
      "name": "settleExpiry",
      "docs": [
        "Record the canonical settlement price for an (asset, expiry) tuple",
        "from a Pyth Pull `PriceUpdateV2` account. Permissionless \u2014 anyone",
        "can call once the (asset, expiry) is past expiry and a fresh Pyth",
        "update is on-chain."
      ],
      "discriminator": [
        75,
        119,
        150,
        43,
        240,
        9,
        203,
        127
      ],
      "accounts": [
        {
          "name": "caller",
          "docs": [
            "Permissionless. Caller pays for SettlementRecord rent."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "market",
          "docs": [
            "OptionsMarket \u2014 provides the canonical feed_id for this asset."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "arg",
                "path": "assetName"
              }
            ]
          }
        },
        {
          "name": "priceUpdate",
          "docs": [
            "Fresh PriceUpdateV2 from the Pyth Receiver program. Validated by",
            "`get_price_no_older_than(.., &market.pyth_feed_id)` for both feed_id",
            "match and staleness.",
            "",
            "Stage 3 (1b): now `Option`, position unchanged. REQUIRED (present) for a",
            "Pyth market \u2014 a present price_update is wire-identical to before. A",
            "Switchboard market passes None (sentinel) and uses the trailing SB",
            "accounts. The Pyth arm errors `PriceUpdateMissing` if absent on a Pyth market."
          ],
          "optional": true
        },
        {
          "name": "settlementRecord",
          "docs": [
            "The SettlementRecord PDA. Plain `init` \u2014 second call for the same",
            "(asset, expiry) reverts."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  101,
                  116,
                  116,
                  108,
                  101,
                  109,
                  101,
                  110,
                  116
                ]
              },
              {
                "kind": "arg",
                "path": "assetName"
              },
              {
                "kind": "arg",
                "path": "expiry"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "sbQueue",
          "docs": [
            "set) in the SB arm. Not address-pinned (per-network queue)."
          ],
          "optional": true
        },
        {
          "name": "sbSlothashes",
          "docs": [
            "runtime in the SB arm."
          ],
          "optional": true
        },
        {
          "name": "sbInstructions",
          "docs": [
            "runtime in the SB arm, then scanned for the ed25519 ix index."
          ],
          "optional": true
        }
      ],
      "args": [
        {
          "name": "assetName",
          "type": "string"
        },
        {
          "name": "expiry",
          "type": "i64"
        }
      ]
    },
    {
      "name": "settleVault",
      "docs": [
        "Settle a shared vault. Permissionless \u2014 reads the canonical price",
        "from a SettlementRecord PDA written earlier by `settle_expiry`."
      ],
      "discriminator": [
        43,
        37,
        36,
        63,
        170,
        246,
        191,
        230
      ],
      "accounts": [
        {
          "name": "authority",
          "docs": [
            "Permissionless \u2014 anyone can settle a vault once the SettlementRecord",
            "for its (asset, expiry) exists."
          ],
          "signer": true
        },
        {
          "name": "sharedVault",
          "docs": [
            "The shared vault to settle."
          ],
          "writable": true
        },
        {
          "name": "market",
          "docs": [
            "The vault's market \u2014 needed to derive the SettlementRecord PDA from",
            "`market.asset_name`. Constraint pins it to the vault's recorded market."
          ]
        },
        {
          "name": "settlementRecord",
          "docs": [
            "The canonical settlement record for this (asset, expiry). If none",
            "exists, anchor's seed validation + Account deserialization fails",
            "before the handler runs."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  101,
                  116,
                  116,
                  108,
                  101,
                  109,
                  101,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market.asset_name",
                "account": "optionsMarket"
              },
              {
                "kind": "account",
                "path": "shared_vault.expiry",
                "account": "sharedVault"
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "sweepExpiredOrders",
      "docs": [
        "Exchange book \u2014 permissionless post-expiry sweep of resting orders.",
        "Returns each order's escrow to its owner and closes the PDAs. Crank",
        "runs this BEFORE auto_finalize_holders. Spec: exchange-spec \u00a76.3 (Step 5).",
        "remaining_accounts: 4-tuples (order, escrow, owner_asset_account, owner_wallet)."
      ],
      "discriminator": [
        78,
        233,
        74,
        44,
        38,
        191,
        78,
        97
      ],
      "accounts": [
        {
          "name": "caller",
          "docs": [
            "Permissionless caller \u2014 pays the tx fee."
          ],
          "signer": true
        },
        {
          "name": "sharedVault",
          "docs": [
            "Vault these orders belong to. Read for the expiry guard."
          ]
        },
        {
          "name": "market",
          "docs": [
            "Market \u2014 pinned to the vault."
          ]
        },
        {
          "name": "vaultMintRecord",
          "docs": [
            "VaultMint record \u2014 pins option_mint to this vault."
          ]
        },
        {
          "name": "optionMint",
          "docs": [
            "The single Token-2022 mint shared by every order in this batch."
          ],
          "writable": true
        },
        {
          "name": "protocolState",
          "docs": [
            "Protocol state \u2014 signs the escrow-source transfers + closes."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  116,
                  111,
                  99,
                  111,
                  108,
                  95,
                  118,
                  50
                ]
              }
            ]
          }
        },
        {
          "name": "transferHookProgram",
          "docs": [
            "Transfer hook program \u2014 used only by ResaleAsk tuples."
          ]
        },
        {
          "name": "extraAccountMetaList",
          "docs": [
            "ExtraAccountMetaList for the transfer hook."
          ]
        },
        {
          "name": "hookState",
          "docs": [
            "HookState for the transfer hook."
          ]
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "token2022Program",
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "withdrawFromVault",
      "docs": [
        "Withdraw uncommitted collateral from a shared vault."
      ],
      "discriminator": [
        180,
        34,
        37,
        46,
        156,
        0,
        211,
        238
      ],
      "accounts": [
        {
          "name": "writer",
          "docs": [
            "The writer withdrawing collateral."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "sharedVault",
          "docs": [
            "The shared vault."
          ],
          "writable": true
        },
        {
          "name": "writerPosition",
          "docs": [
            "Writer's position in the vault."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  119,
                  114,
                  105,
                  116,
                  101,
                  114,
                  95,
                  112,
                  111,
                  115,
                  105,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "sharedVault"
              },
              {
                "kind": "account",
                "path": "writer"
              }
            ]
          }
        },
        {
          "name": "vaultUsdcAccount",
          "docs": [
            "Vault's USDC token account \u2014 source of withdrawal."
          ],
          "writable": true
        },
        {
          "name": "writerUsdcAccount",
          "docs": [
            "Writer's USDC token account \u2014 destination."
          ],
          "writable": true
        },
        {
          "name": "protocolState",
          "docs": [
            "Protocol state \u2014 for USDC mint validation."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  116,
                  111,
                  99,
                  111,
                  108,
                  95,
                  118,
                  50
                ]
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "docs": [
            "Standard SPL Token program."
          ],
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "sharesToWithdraw",
          "type": "u64"
        }
      ]
    },
    {
      "name": "withdrawPostSettlement",
      "docs": [
        "Withdraw remaining collateral after vault settlement."
      ],
      "discriminator": [
        158,
        88,
        59,
        220,
        107,
        159,
        41,
        44
      ],
      "accounts": [
        {
          "name": "writer",
          "docs": [
            "The writer withdrawing remaining collateral."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "sharedVault",
          "docs": [
            "The settled shared vault."
          ],
          "writable": true
        },
        {
          "name": "writerPosition",
          "docs": [
            "Writer's position \u2014 will be closed after withdrawal."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  119,
                  114,
                  105,
                  116,
                  101,
                  114,
                  95,
                  112,
                  111,
                  115,
                  105,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "sharedVault"
              },
              {
                "kind": "account",
                "path": "writer"
              }
            ]
          }
        },
        {
          "name": "vaultUsdcAccount",
          "docs": [
            "Vault's USDC token account."
          ],
          "writable": true
        },
        {
          "name": "writerUsdcAccount",
          "docs": [
            "Writer's USDC token account \u2014 destination."
          ],
          "writable": true
        },
        {
          "name": "protocolState",
          "docs": [
            "Protocol state \u2014 for USDC mint validation."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  116,
                  111,
                  99,
                  111,
                  108,
                  95,
                  118,
                  50
                ]
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "docs": [
            "Standard SPL Token program."
          ],
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    }
  ],
  "accounts": [
    {
      "name": "epochConfig",
      "discriminator": [
        190,
        66,
        87,
        197,
        214,
        153,
        144,
        193
      ]
    },
    {
      "name": "optionsMarket",
      "discriminator": [
        67,
        30,
        90,
        36,
        130,
        219,
        166,
        8
      ]
    },
    {
      "name": "priceUpdateV2",
      "discriminator": [
        34,
        241,
        35,
        99,
        157,
        126,
        244,
        205
      ]
    },
    {
      "name": "protocolState",
      "discriminator": [
        33,
        51,
        173,
        134,
        35,
        140,
        195,
        248
      ]
    },
    {
      "name": "restingOrder",
      "discriminator": [
        125,
        151,
        65,
        43,
        90,
        207,
        190,
        104
      ]
    },
    {
      "name": "settlementRecord",
      "discriminator": [
        172,
        159,
        67,
        74,
        96,
        85,
        37,
        205
      ]
    },
    {
      "name": "sharedVault",
      "discriminator": [
        195,
        36,
        66,
        128,
        41,
        62,
        161,
        142
      ]
    },
    {
      "name": "triggerOrder",
      "discriminator": [
        236,
        61,
        42,
        190,
        152,
        12,
        106,
        116
      ]
    },
    {
      "name": "vaultMint",
      "discriminator": [
        219,
        139,
        146,
        175,
        62,
        90,
        224,
        254
      ]
    },
    {
      "name": "vaultResaleListing",
      "discriminator": [
        122,
        137,
        187,
        45,
        94,
        125,
        117,
        110
      ]
    },
    {
      "name": "volOracle",
      "discriminator": [
        6,
        86,
        139,
        236,
        75,
        70,
        119,
        72
      ]
    },
    {
      "name": "writerPosition",
      "discriminator": [
        195,
        252,
        56,
        77,
        221,
        13,
        8,
        69
      ]
    }
  ],
  "events": [
    {
      "name": "holdersFinalized",
      "discriminator": [
        201,
        31,
        130,
        144,
        98,
        150,
        173,
        199
      ]
    },
    {
      "name": "marketSettled",
      "discriminator": [
        237,
        212,
        22,
        175,
        201,
        117,
        215,
        99
      ]
    },
    {
      "name": "optionCancelled",
      "discriminator": [
        200,
        7,
        36,
        77,
        69,
        191,
        174,
        148
      ]
    },
    {
      "name": "optionExercised",
      "discriminator": [
        34,
        100,
        89,
        14,
        247,
        159,
        22,
        97
      ]
    },
    {
      "name": "optionExpired",
      "discriminator": [
        164,
        0,
        177,
        167,
        225,
        148,
        88,
        250
      ]
    },
    {
      "name": "optionListedForResale",
      "discriminator": [
        72,
        5,
        23,
        201,
        179,
        134,
        149,
        31
      ]
    },
    {
      "name": "optionPurchased",
      "discriminator": [
        9,
        175,
        211,
        168,
        31,
        202,
        39,
        191
      ]
    },
    {
      "name": "optionResold",
      "discriminator": [
        24,
        199,
        191,
        176,
        131,
        186,
        52,
        64
      ]
    },
    {
      "name": "optionWritten",
      "discriminator": [
        216,
        89,
        143,
        186,
        129,
        212,
        10,
        147
      ]
    },
    {
      "name": "orderCancelled",
      "discriminator": [
        108,
        56,
        128,
        68,
        168,
        113,
        168,
        239
      ]
    },
    {
      "name": "orderFilled",
      "discriminator": [
        120,
        124,
        109,
        66,
        249,
        116,
        174,
        30
      ]
    },
    {
      "name": "orderPosted",
      "discriminator": [
        238,
        139,
        177,
        68,
        152,
        67,
        157,
        80
      ]
    },
    {
      "name": "orderSwept",
      "discriminator": [
        69,
        108,
        22,
        159,
        29,
        97,
        255,
        27
      ]
    },
    {
      "name": "premiumClaimed",
      "discriminator": [
        60,
        221,
        78,
        168,
        150,
        45,
        78,
        169
      ]
    },
    {
      "name": "resaleCancelled",
      "discriminator": [
        136,
        250,
        89,
        243,
        72,
        144,
        231,
        75
      ]
    },
    {
      "name": "seriesCreated",
      "discriminator": [
        2,
        164,
        54,
        38,
        24,
        181,
        233,
        180
      ]
    },
    {
      "name": "triggerCancelled",
      "discriminator": [
        158,
        125,
        205,
        196,
        217,
        173,
        189,
        250
      ]
    },
    {
      "name": "triggerExecuted",
      "discriminator": [
        11,
        230,
        11,
        158,
        235,
        50,
        186,
        112
      ]
    },
    {
      "name": "triggerPlaced",
      "discriminator": [
        168,
        173,
        202,
        76,
        152,
        169,
        172,
        181
      ]
    },
    {
      "name": "triggerSkipped",
      "discriminator": [
        184,
        106,
        13,
        205,
        154,
        143,
        86,
        96
      ]
    },
    {
      "name": "vaultBurnUnsold",
      "discriminator": [
        157,
        246,
        255,
        145,
        235,
        202,
        218,
        246
      ]
    },
    {
      "name": "vaultCreated",
      "discriminator": [
        117,
        25,
        120,
        254,
        75,
        236,
        78,
        115
      ]
    },
    {
      "name": "vaultDeposited",
      "discriminator": [
        59,
        62,
        43,
        200,
        220,
        104,
        100,
        67
      ]
    },
    {
      "name": "vaultExercised",
      "discriminator": [
        130,
        23,
        134,
        202,
        255,
        53,
        104,
        154
      ]
    },
    {
      "name": "vaultListingCancelled",
      "discriminator": [
        97,
        181,
        225,
        122,
        44,
        51,
        153,
        85
      ]
    },
    {
      "name": "vaultListingCreated",
      "discriminator": [
        50,
        46,
        115,
        108,
        83,
        108,
        160,
        48
      ]
    },
    {
      "name": "vaultListingFilled",
      "discriminator": [
        140,
        0,
        162,
        53,
        253,
        29,
        112,
        212
      ]
    },
    {
      "name": "vaultListingsAutoCancelled",
      "discriminator": [
        189,
        153,
        198,
        220,
        146,
        251,
        162,
        20
      ]
    },
    {
      "name": "vaultMinted",
      "discriminator": [
        255,
        29,
        220,
        47,
        251,
        229,
        64,
        246
      ]
    },
    {
      "name": "vaultPostSettlementWithdraw",
      "discriminator": [
        40,
        198,
        199,
        220,
        212,
        121,
        133,
        228
      ]
    },
    {
      "name": "vaultPurchased",
      "discriminator": [
        106,
        70,
        42,
        129,
        49,
        102,
        91,
        78
      ]
    },
    {
      "name": "vaultReclaimed",
      "discriminator": [
        23,
        178,
        119,
        136,
        48,
        93,
        111,
        133
      ]
    },
    {
      "name": "vaultSettled",
      "discriminator": [
        203,
        151,
        101,
        220,
        6,
        59,
        48,
        30
      ]
    },
    {
      "name": "vaultWithdrawn",
      "discriminator": [
        238,
        9,
        219,
        172,
        188,
        77,
        72,
        104
      ]
    },
    {
      "name": "writersFinalized",
      "discriminator": [
        39,
        218,
        200,
        17,
        34,
        240,
        227,
        77
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "unauthorized",
      "msg": "Unauthorized: signer is not the protocol admin"
    },
    {
      "code": 6001,
      "name": "expiryInPast",
      "msg": "Expiry timestamp must be in the future"
    },
    {
      "code": 6002,
      "name": "invalidStrikePrice",
      "msg": "Strike price must be greater than zero"
    },
    {
      "code": 6003,
      "name": "invalidAssetName",
      "msg": "Asset name must be 1-16 ASCII uppercase letters or digits"
    },
    {
      "code": 6004,
      "name": "invalidAssetClass",
      "msg": "Asset class must be 0-4 (crypto, commodity, equity, forex, etf)"
    },
    {
      "code": 6005,
      "name": "assetMismatch",
      "msg": "Market already exists for this asset with different metadata"
    },
    {
      "code": 6006,
      "name": "marketNotExpired",
      "msg": "Market has not expired yet"
    },
    {
      "code": 6007,
      "name": "marketNotSettled",
      "msg": "Market has not been settled yet"
    },
    {
      "code": 6008,
      "name": "invalidSettlementPrice",
      "msg": "Settlement price must be greater than zero"
    },
    {
      "code": 6009,
      "name": "unsupportedCollateral",
      "msg": "Collateral mint must be the protocol's USDC mint"
    },
    {
      "code": 6010,
      "name": "insufficientCollateral",
      "msg": "Insufficient collateral for this option"
    },
    {
      "code": 6011,
      "name": "invalidContractSize",
      "msg": "Contract size must be greater than zero"
    },
    {
      "code": 6012,
      "name": "invalidPremium",
      "msg": "Premium must be greater than zero"
    },
    {
      "code": 6013,
      "name": "notWriter",
      "msg": "Only the writer can perform this action"
    },
    {
      "code": 6014,
      "name": "cannotBuyOwnOption",
      "msg": "Cannot buy your own option"
    },
    {
      "code": 6015,
      "name": "insufficientOptionTokens",
      "msg": "Insufficient option tokens to exercise"
    },
    {
      "code": 6016,
      "name": "optionExpired",
      "msg": "Option has already expired \u2014 cannot price"
    },
    {
      "code": 6017,
      "name": "mathOverflow",
      "msg": "Arithmetic overflow"
    },
    {
      "code": 6018,
      "name": "customVaultSingleWriter",
      "msg": "Custom vaults only allow the original creator to deposit"
    },
    {
      "code": 6019,
      "name": "vaultAlreadySettled",
      "msg": "Vault has been settled, no more deposits allowed"
    },
    {
      "code": 6020,
      "name": "vaultExpired",
      "msg": "Vault expiry has passed"
    },
    {
      "code": 6021,
      "name": "invalidEpochExpiry",
      "msg": "Invalid epoch expiry - must fall on configured day and hour"
    },
    {
      "code": 6022,
      "name": "insufficientVaultCollateral",
      "msg": "Insufficient free collateral in writer's vault position"
    },
    {
      "code": 6023,
      "name": "collateralCommitted",
      "msg": "Collateral is committed to active options and cannot be withdrawn"
    },
    {
      "code": 6024,
      "name": "noTokensToBurn",
      "msg": "No unsold tokens to burn"
    },
    {
      "code": 6025,
      "name": "nothingToClaim",
      "msg": "Nothing to claim - all premium already withdrawn"
    },
    {
      "code": 6026,
      "name": "slippageExceeded",
      "msg": "Premium exceeds buyer's maximum (slippage protection)"
    },
    {
      "code": 6027,
      "name": "vaultNotSettled",
      "msg": "Vault not yet settled"
    },
    {
      "code": 6028,
      "name": "optionNotInTheMoney",
      "msg": "Option is not in the money - cannot exercise"
    },
    {
      "code": 6029,
      "name": "invalidVaultMint",
      "msg": "Option mint does not belong to this vault"
    },
    {
      "code": 6030,
      "name": "claimPremiumFirst",
      "msg": "Claim all premium before withdrawing shares"
    },
    {
      "code": 6031,
      "name": "invalidBatchAccounts",
      "msg": "remaining_accounts length must be a multiple of 2 (holder_option_ata, holder_usdc_ata pairs)"
    },
    {
      "code": 6032,
      "name": "writerPositionVaultMismatch",
      "msg": "writer_position.vault does not match the shared_vault passed to this instruction"
    },
    {
      "code": 6033,
      "name": "writerWalletMismatch",
      "msg": "writer_wallet pubkey does not match writer_position.owner \u2014 refusing to drain rent to a stranger"
    },
    {
      "code": 6034,
      "name": "listingExhausted",
      "msg": "listing has fewer tokens available than requested"
    },
    {
      "code": 6035,
      "name": "notResaleSeller",
      "msg": "only the listing's seller can cancel it"
    },
    {
      "code": 6036,
      "name": "invalidListingEscrow",
      "msg": "listing escrow does not belong to this vault"
    },
    {
      "code": 6037,
      "name": "listingMismatch",
      "msg": "listing PDA derivation failed or its mint/vault doesn't match the batch"
    },
    {
      "code": 6038,
      "name": "priceUpdateBeforeExpiry",
      "msg": "Pyth price update publish_time is before vault expiry"
    },
    {
      "code": 6039,
      "name": "priceUpdateTooFarFromExpiry",
      "msg": "Pyth price update publish_time is more than 60s after vault expiry"
    },
    {
      "code": 6040,
      "name": "priceConfidenceTooWide",
      "msg": "Pyth EMA confidence interval exceeds MAX_CONF_BPS at settlement"
    },
    {
      "code": 6041,
      "name": "holderExerciseWindowOpen",
      "msg": "Holder exercise window still open \u2014 writers must wait until \\\n         vault.expiry + EXERCISE_WINDOW before withdrawing"
    },
    {
      "code": 6042,
      "name": "invalidPythFeedId",
      "msg": "Pyth feed ID cannot be all zeros \u2014 register a real feed"
    },
    {
      "code": 6043,
      "name": "volOracleNotInitialized",
      "msg": "VolOracle account not initialized for this asset"
    },
    {
      "code": 6044,
      "name": "volOracleWarmup",
      "msg": "VolOracle in warmup \u2014 needs 168 samples (7 days) before reads are valid"
    },
    {
      "code": 6045,
      "name": "volOracleStale",
      "msg": "VolOracle stale \u2014 most recent sample is older than 6 hours"
    },
    {
      "code": 6046,
      "name": "volOraclePushTooSoon",
      "msg": "VolOracle push too soon \u2014 must wait at least 55 minutes since last push"
    },
    {
      "code": 6047,
      "name": "volOraclePriceStale",
      "msg": "Pyth price update for vol push is older than 60 seconds"
    },
    {
      "code": 6048,
      "name": "volOracleInvalidSpot",
      "msg": "Pyth spot price for vol push is zero or negative"
    },
    {
      "code": 6049,
      "name": "volOracleMathError",
      "msg": "VolOracle math error (sqrt domain, division-by-zero, or overflow)"
    },
    {
      "code": 6050,
      "name": "americanPricingFailed",
      "msg": "American BS-2002 pricing failed \u2014 see tx log for raw variant"
    },
    {
      "code": 6051,
      "name": "viewNotSupportedForEuropean",
      "msg": "get_option_price view does not support European style; use frontend pricer"
    },
    {
      "code": 6052,
      "name": "americanVaultsDisabled",
      "msg": "American vaults are disabled \u2014 AMERICAN_ENABLED is false (flip at Stage I)"
    },
    {
      "code": 6053,
      "name": "notAmericanOption",
      "msg": "Option is not American-style \u2014 early exercise is not available"
    },
    {
      "code": 6054,
      "name": "writerAsksDisabled",
      "msg": "Writer asks are not enabled yet \u2014 reserved for Phase 3"
    },
    {
      "code": 6055,
      "name": "seriesMustBeAmerican",
      "msg": "Series mints are American-only in Phase 2 (D12)"
    },
    {
      "code": 6056,
      "name": "vaultVoided",
      "msg": "Vault has been voided via the dead-feed hatch \u2014 no peg fills"
    },
    {
      "code": 6057,
      "name": "settlementRecordExists",
      "msg": "Settlement record exists \u2014 vault is settleable, the dead-feed hatch is forbidden"
    },
    {
      "code": 6058,
      "name": "gracePeriodNotElapsed",
      "msg": "Dead-feed grace window has not elapsed yet"
    },
    {
      "code": 6059,
      "name": "triggerConditionNotMet",
      "msg": "Trigger condition not met \u2014 live price does not satisfy the stored comparator"
    },
    {
      "code": 6060,
      "name": "triggerSourceAtaInvalid",
      "msg": "Trigger source ATA failed fire-time re-verification (owner or mint mismatch)"
    },
    {
      "code": 6061,
      "name": "switchboardVerifyFailed",
      "msg": "Switchboard quote verification failed (signature, slothash, freshness, or missing ED25519 ix)"
    },
    {
      "code": 6062,
      "name": "switchboardFeedNotFound",
      "msg": "Switchboard quote does not contain the expected feed_id"
    },
    {
      "code": 6063,
      "name": "switchboardInsufficientSamples",
      "msg": "Switchboard feed has fewer oracle samples than the required floor"
    },
    {
      "code": 6064,
      "name": "priceUpdateMissing",
      "msg": "Pyth market requires the price_update account, but it was not provided"
    },
    {
      "code": 6065,
      "name": "switchboardAccountsMissing",
      "msg": "Switchboard market requires the queue + SlotHashes + Instructions accounts"
    },
    {
      "code": 6066,
      "name": "invalidOracleSource",
      "msg": "Unknown oracle_source value on the market"
    },
    {
      "code": 6067,
      "name": "noEd25519Instruction",
      "msg": "No ED25519 instruction found in the transaction for Switchboard verification"
    },
    {
      "code": 6068,
      "name": "invalidSwitchboardSysvar",
      "msg": "Switchboard sysvar account address mismatch (SlotHashes or Instructions)"
    },
    {
      "code": 6069,
      "name": "switchboardSettleWindowElapsed",
      "msg": "Switchboard settlement window elapsed \u2014 settle within 5 min of expiry or reclaim after grace"
    }
  ],
  "types": [
    {
      "name": "comparator",
      "docs": [
        "The comparator the live EMA must satisfy against `threshold_usdc` at fire",
        "time. Direction is EXPLICIT and stored \u2014 no implicit \"stop vs limit\"",
        "inference (spec R4).",
        "",
        "**Variant order is load-bearing** (LessOrEqual = 0, GreaterOrEqual = 1)."
      ],
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "lessOrEqual"
          },
          {
            "name": "greaterOrEqual"
          }
        ]
      }
    },
    {
      "name": "epochConfig",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "authority",
            "docs": [
              "Who can modify the epoch schedule (protocol admin)."
            ],
            "type": "pubkey"
          },
          {
            "name": "weeklyExpiryDay",
            "docs": [
              "Day of week for weekly expiries. 0 = Sunday, 5 = Friday, 6 = Saturday."
            ],
            "type": "u8"
          },
          {
            "name": "weeklyExpiryHour",
            "docs": [
              "Hour (UTC, 0-23) for weekly expiries. Default 8 = 08:00 UTC."
            ],
            "type": "u8"
          },
          {
            "name": "monthlyEnabled",
            "docs": [
              "Whether the last Friday of each month has a separate monthly epoch."
            ],
            "type": "bool"
          },
          {
            "name": "minEpochDurationDays",
            "docs": [
              "Minimum days to expiry for new epoch vaults (e.g., 1 day).",
              "Prevents creating vaults that expire too soon."
            ],
            "type": "u8"
          },
          {
            "name": "bump",
            "docs": [
              "PDA bump seed."
            ],
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "exerciseStyle",
      "docs": [
        "Exercise style for the option contracts a vault writes.",
        "",
        "**Variant order is load-bearing.** Reordering after Pass 1 ships breaks",
        "every existing vault on-chain \u2014 the byte that encodes this enum is a",
        "single Borsh discriminator (0 or 1). Pre-Pass-1 vaults are migrated by",
        "zero-filling the new trailing byte, which deserializes as variant 0",
        "(European). Swapping the order would silently retag every legacy vault",
        "as American. **Do not reorder.**",
        "",
        "Phase 2 Stage C Pass 1."
      ],
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "european"
          },
          {
            "name": "american"
          }
        ]
      }
    },
    {
      "name": "holdersFinalized",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "holdersProcessed",
            "type": "u32"
          },
          {
            "name": "totalBurned",
            "type": "u64"
          },
          {
            "name": "totalPaidOut",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "marketSettled",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "market",
            "type": "pubkey"
          },
          {
            "name": "settlementPrice",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "optionCancelled",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "position",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "optionExercised",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "position",
            "type": "pubkey"
          },
          {
            "name": "exerciser",
            "type": "pubkey"
          },
          {
            "name": "settlementPrice",
            "type": "u64"
          },
          {
            "name": "pnl",
            "type": "u64"
          },
          {
            "name": "tokensBurned",
            "type": "u64"
          },
          {
            "name": "profitable",
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "optionExpired",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "position",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "optionListedForResale",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "position",
            "type": "pubkey"
          },
          {
            "name": "seller",
            "type": "pubkey"
          },
          {
            "name": "resalePremium",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "optionPriceQuote",
      "docs": [
        "View-instruction return type. AnchorSerialize/Deserialize for IDL +",
        "`.view()` decode on the client; Copy/Clone/Debug for ergonomic Rust",
        "consumption (no allocations)."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "premiumPerContract",
            "docs": [
              "Quoted premium per contract in USDC smallest units (6 decimals).",
              "Matches VaultMint.premium_per_contract scale."
            ],
            "type": "u64"
          },
          {
            "name": "volUsedScaled",
            "docs": [
              "Realized vol used in the computation, at solmath SCALE 1e12. From",
              "realized_vol_annualized over the oracle's 30d window."
            ],
            "type": "i64"
          },
          {
            "name": "spotUsedScaled",
            "docs": [
              "Spot used in the computation, at solmath SCALE 1e12. From",
              "VolOracle.last_spot_price."
            ],
            "type": "i64"
          },
          {
            "name": "computedAtTs",
            "docs": [
              "On-chain Clock unix_timestamp at the moment the quote was computed."
            ],
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "optionPurchased",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "market",
            "type": "pubkey"
          },
          {
            "name": "position",
            "type": "pubkey"
          },
          {
            "name": "buyer",
            "type": "pubkey"
          },
          {
            "name": "premium",
            "type": "u64"
          },
          {
            "name": "fee",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "optionResold",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "position",
            "type": "pubkey"
          },
          {
            "name": "seller",
            "type": "pubkey"
          },
          {
            "name": "buyer",
            "type": "pubkey"
          },
          {
            "name": "resalePremium",
            "type": "u64"
          },
          {
            "name": "fee",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "optionType",
      "docs": [
        "Whether this option is a call (right to buy) or put (right to sell).",
        "Lives on `SharedVault` post-Stage-2; kept here because vaults import it."
      ],
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "call"
          },
          {
            "name": "put"
          }
        ]
      }
    },
    {
      "name": "optionWritten",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "market",
            "type": "pubkey"
          },
          {
            "name": "writer",
            "type": "pubkey"
          },
          {
            "name": "position",
            "type": "pubkey"
          },
          {
            "name": "optionMint",
            "type": "pubkey"
          },
          {
            "name": "premium",
            "type": "u64"
          },
          {
            "name": "collateral",
            "type": "u64"
          },
          {
            "name": "contractSize",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "optionsMarket",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "assetName",
            "docs": [
              "Human-readable, normalized asset identifier (\"SOL\", \"BTC\", \"AAPL\", ...).",
              "Max 16 chars, ASCII-uppercase, alphanumeric only."
            ],
            "type": "string"
          },
          {
            "name": "pythFeedId",
            "docs": [
              "The 32-byte Pyth Pull oracle feed ID for this asset.",
              "HIGH-5 (audit Run-7): proof-bound at create_market AND",
              "migrate_pyth_feed via a PriceUpdateV2 account whose",
              "`verification_level == Full` and `price_message.feed_id` matches.",
              "settle_expiry re-validates the same proof at settlement time."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "assetClass",
            "docs": [
              "Asset class for categorizing the underlying asset.",
              "0 = crypto, 1 = commodity, 2 = equity, 3 = forex, 4 = ETF.",
              "Metadata-only today \u2014 no surviving on-chain or frontend pricing",
              "logic branches on this value."
            ],
            "type": "u8"
          },
          {
            "name": "bump",
            "docs": [
              "PDA bump seed."
            ],
            "type": "u8"
          },
          {
            "name": "oracleSource",
            "docs": [
              "Oracle backing this asset's spot price.",
              "`0` = Pyth (pull), `1` = Switchboard (On-Demand). See",
              "`ORACLE_SOURCE_*` consts below.",
              "",
              "Trailing-appended (Stage 2 of the Switchboard arc) AFTER `bump`,",
              "following the `carry_rate_bps` / `exercise_style` precedent on",
              "`SharedVault`: legacy 62-byte markets grow to 63 bytes via the",
              "admin-only `migrate_market_oracle_source` instruction, which",
              "zero-fills this trailing byte (\u2192 Pyth, the no-op default). New",
              "markets are born with this set to `ORACLE_SOURCE_PYTH` in",
              "`create_market`.",
              "",
              "The 32-byte `pyth_feed_id` field above is reused as the oracle id for",
              "BOTH sources (a Switchboard feedHash is also 32 bytes); only its",
              "MEANING routes by this field. INERT until Stage 3 wires the read-arm",
              "match in `utils/price_oracle.rs` \u2014 every handler stays unconditionally",
              "Pyth today, so this field is read by nothing."
            ],
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "orderCancelled",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "order",
            "type": "pubkey"
          },
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "optionMint",
            "type": "pubkey"
          },
          {
            "name": "kind",
            "type": "u8"
          },
          {
            "name": "amountReturned",
            "type": "u64"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "orderFilled",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "order",
            "type": "pubkey"
          },
          {
            "name": "optionMint",
            "type": "pubkey"
          },
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "kind",
            "type": "u8"
          },
          {
            "name": "maker",
            "type": "pubkey"
          },
          {
            "name": "taker",
            "type": "pubkey"
          },
          {
            "name": "pricePerContract",
            "type": "u64"
          },
          {
            "name": "fillQuantity",
            "type": "u64"
          },
          {
            "name": "fee",
            "type": "u64"
          },
          {
            "name": "quantityRemaining",
            "type": "u64"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "orderKind",
      "docs": [
        "Which side of the book this order sits on, and (for asks) what backs it.",
        "",
        "**Variant order is load-bearing.** The Borsh discriminator is a single",
        "byte encoding the variant index (Bid = 0, ResaleAsk = 1, WriterAsk = 2,",
        "VaultPeg = 3); reordering after this ships would silently retag every",
        "existing order. Do not reorder \u2014 append new variants only."
      ],
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "bid"
          },
          {
            "name": "resaleAsk"
          },
          {
            "name": "writerAsk"
          },
          {
            "name": "vaultPeg"
          }
        ]
      }
    },
    {
      "name": "orderPosted",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "order",
            "type": "pubkey"
          },
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "optionMint",
            "type": "pubkey"
          },
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "kind",
            "type": "u8"
          },
          {
            "name": "pricePerContract",
            "type": "u64"
          },
          {
            "name": "quantity",
            "type": "u64"
          },
          {
            "name": "nonce",
            "type": "u64"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "orderSwept",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "order",
            "type": "pubkey"
          },
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "optionMint",
            "type": "pubkey"
          },
          {
            "name": "kind",
            "type": "u8"
          },
          {
            "name": "amountReturned",
            "type": "u64"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "premiumClaimed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "writer",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "priceFeedMessage",
      "repr": {
        "kind": "c"
      },
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "feedId",
            "docs": [
              "`FeedId` but avoid the type alias because of compatibility issues with Anchor's `idl-build` feature."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "price",
            "type": "i64"
          },
          {
            "name": "conf",
            "type": "u64"
          },
          {
            "name": "exponent",
            "type": "i32"
          },
          {
            "name": "publishTime",
            "docs": [
              "The timestamp of this price update in seconds"
            ],
            "type": "i64"
          },
          {
            "name": "prevPublishTime",
            "docs": [
              "The timestamp of the previous price update. This field is intended to allow users to",
              "identify the single unique price update for any moment in time:",
              "for any time t, the unique update is the one such that prev_publish_time < t <= publish_time.",
              "",
              "Note that there may not be such an update while we are migrating to the new message-sending logic,",
              "as some price updates on pythnet may not be sent to other chains (because the message-sending",
              "logic may not have triggered). We can solve this problem by making the message-sending mandatory",
              "(which we can do once publishers have migrated over).",
              "",
              "Additionally, this field may be equal to publish_time if the message is sent on a slot where",
              "where the aggregation was unsuccesful. This problem will go away once all publishers have",
              "migrated over to a recent version of pyth-agent."
            ],
            "type": "i64"
          },
          {
            "name": "emaPrice",
            "type": "i64"
          },
          {
            "name": "emaConf",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "priceUpdateV2",
      "docs": [
        "A price update account. This account is used by the Pyth Receiver program to store a verified price update from a Pyth price feed.",
        "It contains:",
        "- `write_authority`: The write authority for this account. This authority can close this account to reclaim rent or update the account to contain a different price update.",
        "- `verification_level`: The [`VerificationLevel`] of this price update. This represents how many Wormhole guardian signatures have been verified for this price update.",
        "- `price_message`: The actual price update.",
        "- `posted_slot`: The slot at which this price update was posted."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "writeAuthority",
            "type": "pubkey"
          },
          {
            "name": "verificationLevel",
            "type": {
              "defined": {
                "name": "verificationLevel"
              }
            }
          },
          {
            "name": "priceMessage",
            "type": {
              "defined": {
                "name": "priceFeedMessage"
              }
            }
          },
          {
            "name": "postedSlot",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "protocolState",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "admin",
            "docs": [
              "The admin wallet that can update protocol settings.",
              "Set to the signer of the `initialize_protocol` transaction."
            ],
            "type": "pubkey"
          },
          {
            "name": "feeBps",
            "docs": [
              "Fee charged on option purchases, in basis points (1 bps = 0.01%).",
              "Default: 50 bps = 0.50%.",
              "Example: on a 100 USDC premium, the fee is 0.50 USDC."
            ],
            "type": "u16"
          },
          {
            "name": "treasury",
            "docs": [
              "The treasury token account (PDA) that collects protocol fees in USDC."
            ],
            "type": "pubkey"
          },
          {
            "name": "usdcMint",
            "docs": [
              "The USDC mint address. Stored so all instructions can validate that",
              "token accounts are denominated in USDC."
            ],
            "type": "pubkey"
          },
          {
            "name": "totalMarkets",
            "docs": [
              "Running count of all markets created. Used for stats/tracking."
            ],
            "type": "u64"
          },
          {
            "name": "totalVolume",
            "docs": [
              "Running total of all USDC volume (premiums + settlements) flowing",
              "through the protocol. Scaled by 10^6 (USDC decimals)."
            ],
            "type": "u64"
          },
          {
            "name": "bump",
            "docs": [
              "PDA bump seed, stored so we don't have to recalculate it."
            ],
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "resaleCancelled",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "position",
            "type": "pubkey"
          },
          {
            "name": "seller",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "restingOrder",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "owner",
            "docs": [
              "Wallet that posted the order. Receives proceeds + rent on close, and",
              "the returned escrow on cancel/sweep."
            ],
            "type": "pubkey"
          },
          {
            "name": "optionMint",
            "docs": [
              "The Token-2022 option mint this order trades. Part of the PDA seed."
            ],
            "type": "pubkey"
          },
          {
            "name": "vault",
            "docs": [
              "The SharedVault the option mint was minted from. Stored for market",
              "context + crank enumeration (mirrors VaultResaleListing.vault)."
            ],
            "type": "pubkey"
          },
          {
            "name": "kind",
            "docs": [
              "Bid / ResaleAsk / WriterAsk. See `OrderKind`."
            ],
            "type": {
              "defined": {
                "name": "orderKind"
              }
            }
          },
          {
            "name": "pricePerContract",
            "docs": [
              "USDC per contract (6 decimals), set at post time, immutable."
            ],
            "type": "u64"
          },
          {
            "name": "quantityRemaining",
            "docs": [
              "Contracts still resting (0 decimals). Decremented on each partial fill;",
              "the order auto-closes when this hits zero."
            ],
            "type": "u64"
          },
          {
            "name": "quantityInitial",
            "docs": [
              "Contracts at post time. Never mutated \u2014 kept for fill-ratio analytics."
            ],
            "type": "u64"
          },
          {
            "name": "createdAt",
            "docs": [
              "Unix timestamp when the order was posted."
            ],
            "type": "i64"
          },
          {
            "name": "nonce",
            "docs": [
              "Client-supplied uniqueness nonce. Part of the PDA seed."
            ],
            "type": "u64"
          },
          {
            "name": "bump",
            "docs": [
              "PDA bump seed."
            ],
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "seriesCreated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "optionMint",
            "type": "pubkey"
          },
          {
            "name": "market",
            "type": "pubkey"
          },
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "strike",
            "type": "u64"
          },
          {
            "name": "expiry",
            "type": "i64"
          },
          {
            "name": "optionType",
            "type": "u8"
          },
          {
            "name": "exerciseStyle",
            "type": "u8"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "settlementRecord",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "assetName",
            "docs": [
              "Asset this settlement is for. Matches OptionsMarket.asset_name",
              "(already normalized to ASCII uppercase + alphanumeric by the",
              "market PDA derivation)."
            ],
            "type": "string"
          },
          {
            "name": "expiry",
            "docs": [
              "Unix timestamp of the expiry boundary this settlement records."
            ],
            "type": "i64"
          },
          {
            "name": "settlementPrice",
            "docs": [
              "Canonical settlement price for this (asset, expiry), scaled by 1e6",
              "(USDC decimals). Today this is admin-supplied (Pyth-mocked); in",
              "production it would be read from a Pyth pull-oracle account."
            ],
            "type": "u64"
          },
          {
            "name": "settledAt",
            "docs": [
              "On-chain timestamp at which `settle_expiry` was called. Useful for",
              "audit trails and \"settle was X seconds late\" diagnostics."
            ],
            "type": "i64"
          },
          {
            "name": "pythPublishTime",
            "docs": [
              "Pyth `publish_time` of the price update used to derive",
              "`settlement_price`. Must satisfy",
              "`expiry <= pyth_publish_time <= expiry + 60` (enforced by",
              "`settle_expiry`). Distinct from `settled_at`, which is the",
              "on-chain clock at the moment the crank ran. The gap",
              "`settled_at - pyth_publish_time` is the visible \"settle was",
              "late by N seconds\" diagnostic."
            ],
            "type": "i64"
          },
          {
            "name": "bump",
            "docs": [
              "PDA bump seed."
            ],
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "sharedVault",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "market",
            "docs": [
              "Which OptionsMarket this vault belongs to."
            ],
            "type": "pubkey"
          },
          {
            "name": "optionType",
            "docs": [
              "Call or Put \u2014 reuses the existing OptionType enum from market.rs."
            ],
            "type": {
              "defined": {
                "name": "optionType"
              }
            }
          },
          {
            "name": "strikePrice",
            "docs": [
              "Strike price in USDC (6 decimals). Example: $200.00 = 200_000_000."
            ],
            "type": "u64"
          },
          {
            "name": "expiry",
            "docs": [
              "Unix timestamp when all options in this vault expire."
            ],
            "type": "i64"
          },
          {
            "name": "vaultType",
            "docs": [
              "Epoch (shared, Friday expiries) or Custom (single writer, any expiry)."
            ],
            "type": {
              "defined": {
                "name": "vaultType"
              }
            }
          },
          {
            "name": "totalCollateral",
            "docs": [
              "Total USDC locked across all writers in this vault (6 decimals)."
            ],
            "type": "u64"
          },
          {
            "name": "totalShares",
            "docs": [
              "Total shares issued to all writers. First depositor gets 1:1 ratio,",
              "subsequent depositors get proportional shares."
            ],
            "type": "u64"
          },
          {
            "name": "vaultUsdcAccount",
            "docs": [
              "The USDC token account holding this vault's collateral.",
              "Authority = this SharedVault PDA."
            ],
            "type": "pubkey"
          },
          {
            "name": "collateralMint",
            "docs": [
              "Stage 3: the mint of the collateral token. USDC-only enforced today",
              "via a runtime check in `create_shared_vault` against",
              "`protocol_state.usdc_mint`. The field exists so every vault is",
              "self-describing \u2014 the 6 ATA-mint constraints across vault-context",
              "instructions read from here rather than from protocol_state, which",
              "keeps the door open for per-vault collateral diversification later."
            ],
            "type": "pubkey"
          },
          {
            "name": "totalOptionsMinted",
            "docs": [
              "Total option tokens minted from this vault across all writers."
            ],
            "type": "u64"
          },
          {
            "name": "totalOptionsSold",
            "docs": [
              "Total option tokens that have been purchased by buyers."
            ],
            "type": "u64"
          },
          {
            "name": "netPremiumCollected",
            "docs": [
              "Total premium collected in this vault (USDC, 6 decimals).",
              "FIX L-04: renamed from premium_collected for clarity."
            ],
            "type": "u64"
          },
          {
            "name": "premiumPerShareCumulative",
            "docs": [
              "FIX H-01: Cumulative premium per share, scaled by 1e12.",
              "Implements reward-per-share accumulator pattern to prevent",
              "late-depositor premium dilution."
            ],
            "type": "u128"
          },
          {
            "name": "isSettled",
            "docs": [
              "Whether this vault has been settled after expiry."
            ],
            "type": "bool"
          },
          {
            "name": "settlementPrice",
            "docs": [
              "Final settlement price (0 until settled). Copied from market."
            ],
            "type": "u64"
          },
          {
            "name": "collateralRemaining",
            "docs": [
              "Collateral remaining after settlement payouts. Writers withdraw from this."
            ],
            "type": "u64"
          },
          {
            "name": "creator",
            "docs": [
              "Who created this vault (the first depositor).",
              "For Custom vaults, this is the only allowed depositor."
            ],
            "type": "pubkey"
          },
          {
            "name": "createdAt",
            "docs": [
              "When this vault was created."
            ],
            "type": "i64"
          },
          {
            "name": "bump",
            "docs": [
              "PDA bump seed."
            ],
            "type": "u8"
          },
          {
            "name": "carryRateBps",
            "docs": [
              "Cost-of-carry rate at vault creation, in basis points (signed).",
              "Positive = positive carry (e.g. dividend yield on equities).",
              "Negative = negative net carry (e.g. commodities with storage costs).",
              "Defaults to 0 for non-dividend crypto assets.",
              "For future yield-bearing assets (jitoSOL etc.) this will be set",
              "non-zero at vault creation.",
              "",
              "MUST be the last field in this struct -- pre-Stage-A SharedVault",
              "accounts on devnet/mainnet were serialized without this field, so",
              "they're 4 bytes shorter than the new INIT_SPACE. The lazy-realloc",
              "migration in `claim_premium` (Stage A step 2.3) grows them to the",
              "new size and zero-fills the trailing bytes -- which then deserialize",
              "as carry_rate_bps = 0, matching the no-dividend default. Adding any",
              "new field BEFORE this one would break that migration path because",
              "existing on-chain bytes for the trailing fields would shift."
            ],
            "type": "i32"
          },
          {
            "name": "exerciseStyle",
            "docs": [
              "Exercise style for the option contracts minted from this vault.",
              "European (default) = exercise only at expiry; American = exercise",
              "anytime up to expiry. Set at vault creation by `create_shared_vault`",
              "and immutable thereafter.",
              "",
              "MUST be the last field in this struct -- pre-Pass-1 SharedVault",
              "accounts on devnet were serialized without this field, so they're",
              "1 byte shorter than the new INIT_SPACE. The admin-only migration",
              "`migrate_shared_vault_exercise_style` grows them to the new size",
              "and zero-fills the trailing byte -- which then deserializes as",
              "exercise_style = European (variant 0), matching the locked default",
              "for legacy vaults. Adding any new field BEFORE this one would",
              "break that migration path. Same architectural pattern as",
              "Stage A's carry_rate_bps append."
            ],
            "type": {
              "defined": {
                "name": "exerciseStyle"
              }
            }
          },
          {
            "name": "exercisedOptions",
            "docs": [
              "Phase 2 Stage F \u2014 early-exercise accounting (the F\u2192G handshake).",
              "",
              "Cumulative count of option contracts exercised EARLY (pre-expiry) via",
              "`exercise_american`, and the cumulative USDC (6-dec) paid out for them.",
              "Stage F only increments these two counters; it does NOT mutate",
              "total_collateral / total_options_sold / collateral_remaining. Stage G's",
              "settlement math consumes them to avoid double-paying contracts that were",
              "already cash-settled early.",
              "",
              "MUST be the last two fields. Pre-Stage-F vaults were serialized without",
              "them (16 bytes shorter than the new INIT_SPACE). The admin-only",
              "`migrate_shared_vault_exercise_tracking` grows them and zero-fills the",
              "trailing bytes \u2014 which deserialize as 0/0, the correct default for a",
              "vault that has had no early exercises. Same append+migrate discipline as",
              "carry_rate_bps (Stage A) and exercise_style (Stage C Pass 1)."
            ],
            "type": "u64"
          },
          {
            "name": "earlyExercisePayout",
            "type": "u64"
          },
          {
            "name": "spreadBps",
            "docs": [
              "Phase 2 Pass A (exchange) \u2014 peg spread + dead-feed void flag.",
              "",
              "`spread_bps`: flat spread applied over the BS-2002 model quote on",
              "`fill_vault_peg` (Pass B), in basis points \u2014 extra LP yield. Default 0.",
              "`voided`: set true ONCE by `reclaim_unsettled` (Pass D) when a vault is",
              "reclaimed after the dead-feed grace window. A voided vault pays holders",
              "NOTHING and writers exactly pro-rata; **no path may treat `voided` as",
              "`is_settled`** (spec v1.1 global invariant #6).",
              "",
              "MUST be the last two fields. Pre-Pass-A vaults were serialized without",
              "them (3 bytes shorter than the new INIT_SPACE). The admin-only",
              "`migrate_shared_vault_exchange_fields` grows them and zero-fills the",
              "trailing bytes \u2014 which deserialize as spread_bps = 0 / voided = false,",
              "the correct defaults. Same append+migrate discipline as carry_rate_bps",
              "(Stage A), exercise_style (Stage C Pass 1), and exercise tracking (Stage F)."
            ],
            "type": "u16"
          },
          {
            "name": "voided",
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "triggerCancelled",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "triggerOrder",
            "type": "pubkey"
          },
          {
            "name": "owner",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "triggerExecuted",
      "docs": [
        "Emitted on a successful execute_trigger fire. `kind` is the TriggerKind u8",
        "(StopEntryBuy=0, TakeProfitSell=1). `fire_quantity` is the contracts bought",
        "(BUY, always == quantity) or burned (SELL, = min(quantity, balance)).",
        "`premium_or_payout` is the gross USDC paid in (BUY) / capped intrinsic paid",
        "out (SELL). `remaining_quantity` is 0 for a BUY (closed) or the SELL order's",
        "leftover after a partial fire (0 \u21d2 the order was closed)."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "triggerOrder",
            "type": "pubkey"
          },
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "kind",
            "type": "u8"
          },
          {
            "name": "fireQuantity",
            "type": "u64"
          },
          {
            "name": "emaUsed",
            "type": "u64"
          },
          {
            "name": "premiumOrPayout",
            "type": "u64"
          },
          {
            "name": "remainingQuantity",
            "type": "u64"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "triggerKind",
      "docs": [
        "What the trigger does when it fires. v1 routes BOTH through the vault as the",
        "always-on counterparty (never the book, which has no guaranteed liquidity):",
        "",
        "**Variant order is load-bearing** \u2014 the Borsh discriminator is a single byte",
        "encoding the variant index (StopEntryBuy = 0, TakeProfitSell = 1). Append",
        "new variants only; never reorder.",
        "",
        "NOTE: exactly two variants. There is NO StopLossSell \u2014 a true stop-loss must",
        "sell an OTM long, which the vault cannot buy back (it only pays capped",
        "intrinsic, and exercise reverts OTM). Real stop-loss needs the book path and",
        "is deferred to a later phase."
      ],
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "stopEntryBuy"
          },
          {
            "name": "takeProfitSell"
          }
        ]
      }
    },
    {
      "name": "triggerOrder",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "owner",
            "docs": [
              "Wallet that placed the trigger. Receives proceeds/refund + rent on close."
            ],
            "type": "pubkey"
          },
          {
            "name": "market",
            "docs": [
              "The OptionsMarket the option series belongs to. Stored so the Pass-1",
              "execute path can read `market.pyth_feed_id` for the fresh-EMA re-check."
            ],
            "type": "pubkey"
          },
          {
            "name": "optionMint",
            "docs": [
              "The series option mint: the peg-buy target (BUY) or the sell-burn target",
              "(SELL). Part of the PDA seed."
            ],
            "type": "pubkey"
          },
          {
            "name": "vault",
            "docs": [
              "The SharedVault: peg-fill source (BUY) / exercise-payout source (SELL)."
            ],
            "type": "pubkey"
          },
          {
            "name": "kind",
            "docs": [
              "StopEntryBuy / TakeProfitSell. See `TriggerKind`."
            ],
            "type": {
              "defined": {
                "name": "triggerKind"
              }
            }
          },
          {
            "name": "comparator",
            "docs": [
              "The comparator the live EMA must satisfy at fire time. See `Comparator`."
            ],
            "type": {
              "defined": {
                "name": "comparator"
              }
            }
          },
          {
            "name": "thresholdUsdc",
            "docs": [
              "Condition price, USDC 6-dec. The trigger fires when the live EMA",
              "satisfies `comparator` against this value (re-checked on-chain in P1)."
            ],
            "type": "u64"
          },
          {
            "name": "quantity",
            "docs": [
              "Contracts to buy (BUY) or sell (SELL)."
            ],
            "type": "u64"
          },
          {
            "name": "maxPremium",
            "docs": [
              "BUY: PER-CONTRACT escrow ceiling (USDC 6-dec). The escrowed figure is",
              "`max_premium * quantity`. \u26a0\ufe0f UNITS: this is PER-CONTRACT; fill_vault_peg's",
              "own `max_premium` arg (P1) is a fee-inclusive TOTAL \u2014 do not conflate.",
              "SELL: stored as 0 (no escrow)."
            ],
            "type": "u64"
          },
          {
            "name": "holderOptionAta",
            "docs": [
              "SELL: the exact ATA to delegate-burn from at fire (P1).",
              "BUY: the owner's destination option ATA (pre-created at placement) the",
              "peg mints into at fire."
            ],
            "type": "pubkey"
          },
          {
            "name": "escrowFunded",
            "docs": [
              "BUY: true once USDC has been escrowed. SELL: always false."
            ],
            "type": "bool"
          },
          {
            "name": "createdAt",
            "docs": [
              "Unix timestamp when the trigger was placed."
            ],
            "type": "i64"
          },
          {
            "name": "nonce",
            "docs": [
              "Client-supplied uniqueness nonce. Part of the PDA seed."
            ],
            "type": "u64"
          },
          {
            "name": "bump",
            "docs": [
              "PDA bump seed."
            ],
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "triggerPlaced",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "triggerOrder",
            "type": "pubkey"
          },
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "optionMint",
            "type": "pubkey"
          },
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "kind",
            "type": "u8"
          },
          {
            "name": "comparator",
            "type": "u8"
          },
          {
            "name": "thresholdUsdc",
            "type": "u64"
          },
          {
            "name": "quantity",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "triggerSkipped",
      "docs": [
        "Emitted when a SELL trigger's condition + EMA passed but the source ATA holds",
        "zero (the holder moved everything out). A benign no-op: the order STAYS OPEN,",
        "nothing reverts. `reason` 0 = zero source balance."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "triggerOrder",
            "type": "pubkey"
          },
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "reason",
            "type": "u8"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "vaultBurnUnsold",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "writer",
            "type": "pubkey"
          },
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "burned",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "vaultCreated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "market",
            "type": "pubkey"
          },
          {
            "name": "vaultType",
            "type": "u8"
          },
          {
            "name": "strikePrice",
            "type": "u64"
          },
          {
            "name": "expiry",
            "type": "i64"
          },
          {
            "name": "optionType",
            "type": "u8"
          },
          {
            "name": "creator",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "vaultDeposited",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "writer",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "shares",
            "type": "u64"
          },
          {
            "name": "totalCollateral",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "vaultExercised",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "holder",
            "type": "pubkey"
          },
          {
            "name": "quantity",
            "type": "u64"
          },
          {
            "name": "payout",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "vaultListingCancelled",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "listing",
            "type": "pubkey"
          },
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "seller",
            "type": "pubkey"
          },
          {
            "name": "returnedQuantity",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "vaultListingCreated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "listing",
            "type": "pubkey"
          },
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "seller",
            "type": "pubkey"
          },
          {
            "name": "listedQuantity",
            "type": "u64"
          },
          {
            "name": "pricePerContract",
            "type": "u64"
          },
          {
            "name": "createdAt",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "vaultListingFilled",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "listing",
            "type": "pubkey"
          },
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "seller",
            "type": "pubkey"
          },
          {
            "name": "buyer",
            "type": "pubkey"
          },
          {
            "name": "quantity",
            "type": "u64"
          },
          {
            "name": "totalPrice",
            "type": "u64"
          },
          {
            "name": "fee",
            "type": "u64"
          },
          {
            "name": "listingRemaining",
            "type": "u64"
          },
          {
            "name": "listingClosed",
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "vaultListingsAutoCancelled",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "listingsCancelled",
            "type": "u32"
          },
          {
            "name": "tokensReturned",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "vaultMint",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "docs": [
              "Which SharedVault this mint belongs to."
            ],
            "type": "pubkey"
          },
          {
            "name": "writer",
            "docs": [
              "The writer who created this mint."
            ],
            "type": "pubkey"
          },
          {
            "name": "optionMint",
            "docs": [
              "The Token-2022 mint pubkey."
            ],
            "type": "pubkey"
          },
          {
            "name": "premiumPerContract",
            "docs": [
              "Writer's asking price per contract (USDC, 6 decimals).",
              "This is what buyers pay when purchasing from this mint."
            ],
            "type": "u64"
          },
          {
            "name": "quantityMinted",
            "docs": [
              "How many option tokens were originally minted."
            ],
            "type": "u64"
          },
          {
            "name": "quantitySold",
            "docs": [
              "How many option tokens have been sold to buyers."
            ],
            "type": "u64"
          },
          {
            "name": "createdAt",
            "docs": [
              "Timestamp when this mint was created (also used as PDA seed nonce)."
            ],
            "type": "i64"
          },
          {
            "name": "bump",
            "docs": [
              "PDA bump seed."
            ],
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "vaultMinted",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "writer",
            "type": "pubkey"
          },
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "quantity",
            "type": "u64"
          },
          {
            "name": "premiumPerContract",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "vaultPostSettlementWithdraw",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "writer",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "vaultPurchased",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "buyer",
            "type": "pubkey"
          },
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "quantity",
            "type": "u64"
          },
          {
            "name": "totalPremium",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "vaultReclaimed",
      "docs": [
        "Phase 2 Pass D \u2014 emitted once per writer reclaim through the dead-feed hatch",
        "(`reclaim_unsettled`). Distinct from VaultPostSettlementWithdraw (which has",
        "the same field shape) so off-chain indexers can tell a hatch wind-down apart",
        "from an ordinary post-settlement withdrawal: a VaultReclaimed stream means",
        "the vault was voided (holders paid nothing), never settled."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "writer",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "vaultResaleListing",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "seller",
            "docs": [
              "Wallet that created the listing. Receives sale proceeds + rent on close."
            ],
            "type": "pubkey"
          },
          {
            "name": "vault",
            "docs": [
              "Which SharedVault this option mint was minted from. Stored for",
              "reverse lookup + crank enumeration efficiency."
            ],
            "type": "pubkey"
          },
          {
            "name": "optionMint",
            "docs": [
              "The Token-2022 mint being resold."
            ],
            "type": "pubkey"
          },
          {
            "name": "listedQuantity",
            "docs": [
              "Tokens currently sitting in the resale_escrow PDA. Decremented on",
              "each partial fill; listing auto-closes when this hits zero."
            ],
            "type": "u64"
          },
          {
            "name": "pricePerContract",
            "docs": [
              "USDC per contract (6 decimals), set at listing time, immutable."
            ],
            "type": "u64"
          },
          {
            "name": "createdAt",
            "docs": [
              "Unix timestamp when listing was created."
            ],
            "type": "i64"
          },
          {
            "name": "bump",
            "docs": [
              "PDA bump seed."
            ],
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "vaultSettled",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "settlementPrice",
            "type": "u64"
          },
          {
            "name": "totalPayout",
            "type": "u64"
          },
          {
            "name": "collateralRemaining",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "vaultType",
      "docs": [
        "Whether this vault is an epoch (shared) or custom (single-writer) vault."
      ],
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "epoch"
          },
          {
            "name": "custom"
          }
        ]
      }
    },
    {
      "name": "vaultWithdrawn",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "writer",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "shares",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "verificationLevel",
      "docs": [
        "Pyth price updates are bridged to all blockchains via Wormhole.",
        "Using the price updates on another chain requires verifying the signatures of the Wormhole guardians.",
        "The usual process is to check the signatures for two thirds of the total number of guardians, but this can be cumbersome on Solana because of the transaction size limits,",
        "so we also allow for partial verification.",
        "",
        "This enum represents how much a price update has been verified:",
        "- If `Full`, we have verified the signatures for two thirds of the current guardians.",
        "- If `Partial`, only `num_signatures` guardian signatures have been checked.",
        "",
        "# Warning",
        "Using partially verified price updates is dangerous, as it lowers the threshold of guardians that need to collude to produce a malicious price update."
      ],
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "partial",
            "fields": [
              {
                "name": "numSignatures",
                "type": "u8"
              }
            ]
          },
          {
            "name": "full"
          }
        ]
      }
    },
    {
      "name": "volOracle",
      "serialization": "bytemuck",
      "repr": {
        "kind": "c"
      },
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "sumLogReturns",
            "docs": [
              "Running sum of all populated samples (i.e. of `samples[0..sample_count]`).",
              "i128 chosen for headroom: per-sample magnitude max ~ln(10)*SCALE",
              "= 2.3e12; sum across 720 samples bounded at ~1.66e15 -- well under",
              "i128::MAX (1.7e38). O(1) update on each push: add new, subtract evicted.",
              "Placed first so `#[repr(C)]` gives the struct 16-byte alignment from",
              "offset 0; reordering this field below an i64 introduces compiler-",
              "inserted gap bytes that violate bytemuck::Pod."
            ],
            "type": "i128"
          },
          {
            "name": "sumLogReturnsSq",
            "docs": [
              "Running sum of squared samples (raw i64*i64 product, NOT re-scaled).",
              "Per-sample bound (2.3e12)^2 = 5.3e24; sum across 720 = 3.8e27;",
              "fits comfortably in i128. The variance formula descales at read",
              "time, dividing by SCALE^2 (= 1e24) to recover unit variance."
            ],
            "type": "i128"
          },
          {
            "name": "feedId",
            "docs": [
              "32-byte Pyth Pull feed ID. PDA seed."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "samples",
            "docs": [
              "Ring buffer of hourly log returns at solmath SCALE (1e12).",
              "`samples[i] = ln(spot_i / spot_{i-1}) * SCALE`. Always 720 slots;",
              "`sample_count` tracks how many are populated."
            ],
            "type": {
              "array": [
                "i64",
                720
              ]
            }
          },
          {
            "name": "lastSampleTs",
            "docs": [
              "Unix timestamp of the most recent successful push. Drives both",
              "the push-side rate limit (VOL_ORACLE_MIN_PUSH_INTERVAL_SECS) and",
              "the read-side staleness gate (VOL_ORACLE_STALENESS_SECS)."
            ],
            "type": "i64"
          },
          {
            "name": "lastSpotPrice",
            "docs": [
              "Spot price at the time of the most recent push, at solmath SCALE",
              "(1e12). Used by the next push to compute log_return without",
              "reading Pyth history. Replaces the dropped `spot_prices` array.",
              "Stored as i64 (positive only): max i64 ~9.2e18 accommodates spot",
              "prices up to ~$9.2M at SCALE=1e12, comfortably covering BTC and",
              "every equity Opta currently lists."
            ],
            "type": "i64"
          },
          {
            "name": "head",
            "docs": [
              "Next write index in the ring buffer (0..720). Wraps mod 720."
            ],
            "type": "u16"
          },
          {
            "name": "sampleCount",
            "docs": [
              "Number of populated samples. Saturates at VOL_ORACLE_RING_SIZE.",
              "American vault creation is gated on >= VOL_ORACLE_WARMUP_SAMPLES."
            ],
            "type": "u16"
          },
          {
            "name": "bump",
            "docs": [
              "PDA bump seed."
            ],
            "type": "u8"
          },
          {
            "name": "oracleSource",
            "docs": [
              "Oracle backing this feed's spot price (Stage 3, wiring 1a-iii).",
              "`0` = Pyth (pull), `1` = Switchboard (On-Demand). See `ORACLE_SOURCE_*`",
              "in `state/market.rs`. push_vol_sample reads this from the already-loaded",
              "oracle to route the spot read; mint/fill/get_option_price inherit via the",
              "cached `last_spot_price`.",
              "",
              "CLAIMED IN PLACE from `_padding` (offset 5845) \u2014 a SIZE-PRESERVING change:",
              "`_padding` shrank 11\u219210 so `size_of` stays exactly 5856, the leading byte",
              "of the old padding was always zero (Pod zero-init / `load_init` zero-fill),",
              "so every legacy on-chain oracle reads this as `0 = Pyth` with NO migration",
              "and NO realloc. A size-GROWING change would instead panic",
              "`AccountLoader::load` (bytemuck length mismatch) on every legacy oracle."
            ],
            "type": "u8"
          },
          {
            "name": "padAlign",
            "docs": [
              "Explicit alignment slack (offsets 5846..5848) so `seed_vol` below lands",
              "on an 8-byte boundary at offset 5848. `oracle_source` ends at 5846 and",
              "i64 requires 8-byte alignment, so 2 slack bytes are mandatory. This pad",
              "is NAMED (not compiler-implicit) because `bytemuck::Pod` forbids",
              "uninitialized gap bytes \u2014 implicit padding fails the zero_copy derive.",
              "",
              "THIS IS ALIGNMENT SLACK, NOT RESERVED FUTURE-FIELD SPACE. The old",
              "`_padding: [u8; 10]` is now fully spent: 2 bytes here + 8 bytes of",
              "`seed_vol`. There is NO free padding left. A future field cannot be",
              "claimed in place \u2014 it would grow `size_of` past 5856 and panic",
              "`AccountLoader::load` (bytemuck length mismatch) on every legacy",
              "oracle, requiring an admin realloc migration. Do NOT repurpose these",
              "2 bytes for a new field; they exist solely to align `seed_vol`."
            ],
            "type": {
              "array": [
                "u8",
                2
              ]
            }
          },
          {
            "name": "seedVol",
            "docs": [
              "SEED volatility for the under-warmed window \u2014 annualized \u03c3 at solmath",
              "SCALE (1e12), i64. Claimed in place from the old `_padding` (offsets",
              "5848..5856); a SIZE-PRESERVING change, same migration-free trick as",
              "`oracle_source`: every legacy on-chain oracle reads this as 0 via",
              "`load_init` zero-fill, with NO migration and NO realloc. A size-GROWING",
              "change would instead panic `AccountLoader::load` on every legacy oracle.",
              "",
              "ZERO-SAFE SENTINEL: `seed_vol == 0` means \"no seed \u2014 behave exactly as",
              "before.\" The American pricing path (`price_american`) consults this",
              "ONLY when the oracle is under-warmed (`sample_count <",
              "VOL_ORACLE_WARMUP_SAMPLES`); a warm oracle always uses realized vol and",
              "never reads `seed_vol`. Written at birth by `initialize_vol_oracle` so a",
              "brand-new market is priceable from minute one while the realized-vol",
              "ring warms in the background and later takes over. Encode off-chain as",
              "`round(annualized_sigma * 1e12)` (e.g. crypto 0.80 \u2192 800_000_000_000)."
            ],
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "writerPosition",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "owner",
            "docs": [
              "The writer's wallet address."
            ],
            "type": "pubkey"
          },
          {
            "name": "vault",
            "docs": [
              "Which SharedVault this position belongs to."
            ],
            "type": "pubkey"
          },
          {
            "name": "shares",
            "docs": [
              "Writer's proportional share of the vault.",
              "Used to calculate their cut of premium and remaining collateral."
            ],
            "type": "u64"
          },
          {
            "name": "depositedCollateral",
            "docs": [
              "Total USDC this writer has deposited into the vault.",
              "Tracked for reference \u2014 the authoritative value is shares."
            ],
            "type": "u64"
          },
          {
            "name": "premiumClaimed",
            "docs": [
              "How much premium this writer has already claimed.",
              "Prevents double-claiming."
            ],
            "type": "u64"
          },
          {
            "name": "premiumDebt",
            "docs": [
              "FIX H-01: Snapshot of premium_per_share_cumulative at deposit time.",
              "Used in reward-per-share accumulator to prevent late-depositor dilution."
            ],
            "type": "u128"
          },
          {
            "name": "optionsMinted",
            "docs": [
              "Total option tokens this writer has minted from their vault share.",
              "Used to calculate committed collateral (can't withdraw what's backing active options)."
            ],
            "type": "u64"
          },
          {
            "name": "optionsSold",
            "docs": [
              "How many of this writer's minted tokens have been sold to buyers."
            ],
            "type": "u64"
          },
          {
            "name": "depositedAt",
            "docs": [
              "When this position was first created."
            ],
            "type": "i64"
          },
          {
            "name": "bump",
            "docs": [
              "PDA bump seed."
            ],
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "writersFinalized",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "writersProcessed",
            "type": "u32"
          },
          {
            "name": "totalPaidOut",
            "type": "u64"
          },
          {
            "name": "dustSweptToTreasury",
            "docs": [
              "Non-zero only when this batch contained the last writer; otherwise 0."
            ],
            "type": "u64"
          }
        ]
      }
    }
  ]
};
