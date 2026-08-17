(impl-trait 'SP000000000000000000002Q6VF78.pox-5.signer-manager-trait)
(use-trait signer-manager-trait 'SP000000000000000000002Q6VF78.pox-5.signer-manager-trait)

(define-constant ERR_UNAUTHORIZED_ADMIN (err u37001))
(define-constant ERR_STAKER_NOT_ALLOWED (err u37002))
(define-constant ERR_NO_CLAIMABLE_REWARDS (err u37003))

(define-read-only (is-admin (who principal))
  (contract-call? .signer-admin-v1 is-admin current-contract who)
)


(define-public (validate-stake!
    (staker principal)
    (first-index uint)
    (num-indexes uint)
    (amount-ustx uint)
    (amount-sats uint)
    (is-bond bool)
    (signer-calldata (optional (buff 500)))
  )
  (begin
    (asserts! (contract-call? .native-pool-v1 is-delegating staker current-contract) ERR_STAKER_NOT_ALLOWED)
    (ok true)
  )
)


(define-public (register-self
    (signer-manager <signer-manager-trait>)
    (signer-key (buff 33))
    (auth-id uint)
    (signer-sig (buff 65))
  )
  (begin
    (try! (authorize-admin))
    (try! (as-contract?
      ()
      (try! (contract-call? 'SP000000000000000000002Q6VF78.pox-5 grant-signer-key signer-key current-contract auth-id signer-sig))
      (try! (contract-call? 'SP000000000000000000002Q6VF78.pox-5 register-signer signer-manager signer-key))
    ))
    (print { action: "register-self", data: { signer-key: signer-key, block-height: stacks-block-height } })
    (ok true)
  )
)


(define-public (claim-rewards
    (bond-periods (list 6 uint))
    (reward-cycle uint)
  )
  (let (
    (info (try! (as-contract? ()
      (try! (contract-call? 'SP000000000000000000002Q6VF78.pox-5 claim-rewards bond-periods reward-cycle))
    )))
  )
    (print { action: "claim-rewards", data: { total-rewards: (get total-rewards info), reward-cycle: reward-cycle, block-height: stacks-block-height } })
    (ok info)
  )
)

(define-public (claim-staker-rewards
    (reward-cycle uint)
    (bond-index (optional uint))
  )
  (let (
    (staker tx-sender)
    (rewards-info (unwrap-panic (contract-call? 'SP000000000000000000002Q6VF78.pox-5 claim-staker-rewards-for-signer staker reward-cycle bond-index)))
    (earned (get earned rewards-info))
  )
    (asserts! (> earned u0) ERR_NO_CLAIMABLE_REWARDS)
    (try! (as-contract?
      ((with-ft 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token "sbtc-token" earned))
      (try! (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token transfer earned tx-sender staker none))
    ))
    (print { action: "claim-staker-rewards", data: { staker: staker, reward-cycle: reward-cycle, earned: earned, block-height: stacks-block-height } })
    (ok earned)
  )
)


(define-private (authorize-admin)
  (ok (asserts! (and (is-eq contract-caller tx-sender) (is-admin tx-sender)) ERR_UNAUTHORIZED_ADMIN))
)
