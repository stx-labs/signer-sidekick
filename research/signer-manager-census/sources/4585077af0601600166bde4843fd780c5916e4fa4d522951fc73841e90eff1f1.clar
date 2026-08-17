(impl-trait 'SP000000000000000000002Q6VF78.pox-5.signer-manager-trait)
(use-trait signer-manager-trait 'SP000000000000000000002Q6VF78.pox-5.signer-manager-trait)


(define-constant ERR_UNAUTHORIZED_ADMIN (err u30001))
(define-constant ERR_STAKER_NOT_ALLOWED (err u30002))
(define-constant ERR_RECIPIENT_NOT_SET (err u30003))


(define-map allowed-stakers principal bool)

(define-data-var rewards-recipient (optional principal) none)


(define-read-only (is-admin (who principal))
  (contract-call? .signer-admin-v1 is-admin current-contract who)
)

(define-read-only (is-allowed-staker (who principal))
  (default-to false (map-get? allowed-stakers who))
)

(define-read-only (get-rewards-recipient)
  (var-get rewards-recipient)
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
    (asserts! (is-allowed-staker staker) ERR_STAKER_NOT_ALLOWED)
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
    (total (get total-rewards info))
    (recipient (unwrap! (var-get rewards-recipient) ERR_RECIPIENT_NOT_SET))
  )
    (try! (as-contract?
      ((with-ft 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token "sbtc-token" total))
      (try! (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
        transfer total tx-sender recipient none
      ))
    ))
    (print { action: "claim-rewards", data: { total: total, recipient: recipient, reward-cycle: reward-cycle, block-height: stacks-block-height } })
    (ok info)
  )
)


(define-private (authorize-admin)
  (ok (asserts! (and (is-eq contract-caller tx-sender) (is-admin tx-sender)) ERR_UNAUTHORIZED_ADMIN))
)

(define-public (set-allowed-staker (staker principal) (allowed bool))
  (begin
    (try! (authorize-admin))
    (map-set allowed-stakers staker allowed)
    (print { action: "set-allowed-staker", data: { staker: staker, allowed: allowed, block-height: stacks-block-height } })
    (ok true)
  )
)

(define-public (set-rewards-recipient (recipient principal))
  (begin
    (try! (authorize-admin))
    (var-set rewards-recipient (some recipient))
    (print { action: "set-rewards-recipient", data: { recipient: recipient, block-height: stacks-block-height } })
    (ok true)
  )
)
