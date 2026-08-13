(use-trait signer-mgr 'SP000000000000000000002Q6VF78.pox-5.signer-manager-trait)
(impl-trait 'SP000000000000000000002Q6VF78.pox-5.signer-manager-trait)

(define-constant POX5 'SP000000000000000000002Q6VF78.pox-5)
(define-constant SBTC 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token)

(define-constant ERR_UNAUTHORIZED (err u100))
(define-constant ERR_PAUSED       (err u101))
(define-constant ERR_NOT_POX5     (err u102))
(define-constant ERR_SETTLE_FAILED (err u103))
(define-constant ERR_TRANCHE_UNPAID (err u104))
(define-constant ERR_NO_DUST      (err u105))
(define-constant ERR_NO_NEW_REWARDS (err u109))
(define-constant ERR_INVALID_FEE (err u110))
(define-constant ERR_INSUFFICIENT_FEES (err u111))
(define-constant ERR_TRANCHE_TOO_SOON (err u112))
(define-constant ERR_NO_PENDING_FEE (err u113))
(define-constant ERR_COOLDOWN (err u114))

(define-constant MAX_BIPS u10000)

(define-constant MAX_FEE_BIPS u2000)

(define-data-var admin  principal tx-sender)
(define-data-var paused bool false)

(define-read-only (get-admin) (var-get admin))
(define-read-only (is-paused) (var-get paused))

(define-private (assert-admin)
  (ok (asserts! (is-eq contract-caller (var-get admin)) ERR_UNAUTHORIZED)))

(define-public (set-admin (new-admin principal))
  (begin (try! (assert-admin)) (ok (var-set admin new-admin))))

(define-public (set-paused (p bool))
  (begin (try! (assert-admin)) (ok (var-set paused p))))

(define-data-var fee-bips uint u0)
(define-data-var earned-fees uint u0)

(define-map og-stakers principal bool)

(define-read-only (get-fee-bips) (var-get fee-bips))
(define-read-only (get-earned-fees) (var-get earned-fees))

(define-read-only (is-og (staker principal))
  (default-to false (map-get? og-stakers staker)))

(define-read-only (get-effective-fee-bips (staker principal))
  (if (is-og staker) u0 (var-get fee-bips)))

(define-constant FEE_COOLDOWN u144)

(define-data-var pending-fee (optional uint) none)
(define-data-var pending-fee-height uint u0)

(define-read-only (get-pending-fee)
  { fee: (var-get pending-fee),
    proposed-at: (var-get pending-fee-height),
    executable-at: (+ (var-get pending-fee-height) FEE_COOLDOWN) })

(define-public (propose-fee-bips (new-fee uint))
  (begin
    (try! (assert-admin))
    (asserts! (<= new-fee MAX_FEE_BIPS) ERR_INVALID_FEE)
    (var-set pending-fee (some new-fee))
    (var-set pending-fee-height burn-block-height)
    (print { topic: "propose-fee-bips", current: (var-get fee-bips), proposed: new-fee,
      executable-at: (+ burn-block-height FEE_COOLDOWN) })
    (ok new-fee)))

(define-public (confirm-fee-bips)
  (let ((new-fee (unwrap! (var-get pending-fee) ERR_NO_PENDING_FEE)))
    (try! (assert-admin))
    (asserts! (>= burn-block-height (+ (var-get pending-fee-height) FEE_COOLDOWN))
      ERR_COOLDOWN)
    (print { topic: "confirm-fee-bips", old: (var-get fee-bips), new: new-fee })
    (var-set pending-fee none)
    (ok (var-set fee-bips new-fee))))

(define-public (cancel-fee-bips)
  (begin
    (try! (assert-admin))
    (print { topic: "cancel-fee-bips", cancelled: (var-get pending-fee) })
    (ok (var-set pending-fee none))))

(define-public (set-og (staker principal) (og bool))
  (begin
    (try! (assert-admin))
    (if og (map-set og-stakers staker true) (map-delete og-stakers staker))
    (print { topic: "set-og", staker: staker, og: og })
    (ok og)))

(define-private (do-withdraw-fees (amount uint) (recipient principal))
  (let ((available (var-get earned-fees)))
    (asserts! (<= amount available) ERR_INSUFFICIENT_FEES)
    (try! (as-contract? ((with-ft SBTC "sbtc-token" amount))
      (try! (contract-call? SBTC transfer amount current-contract recipient none))))
    (var-set earned-fees (- available amount))
    (print { topic: "withdraw-fees", amount: amount, recipient: recipient })
    (ok amount)))

(define-public (withdraw-fees (amount uint) (recipient principal))
  (begin (try! (assert-admin)) (do-withdraw-fees amount recipient)))

(define-public (withdraw-all-fees (recipient principal))
  (begin (try! (assert-admin)) (do-withdraw-fees (var-get earned-fees) recipient)))

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
    (asserts! (is-eq contract-caller POX5) ERR_NOT_POX5)
    (asserts! (not (var-get paused)) ERR_PAUSED)
    (print { topic: "validate-stake", staker: staker, first-index: first-index,
      num-indexes: num-indexes, amount-ustx: amount-ustx, amount-sats: amount-sats, is-bond: is-bond, signer-calldata: signer-calldata })
    (ok true)
  )
)

(define-public (register-self
    (signer-manager <signer-mgr>)
    (signer-key (buff 33))
    (auth-id uint)
    (signer-sig (buff 65))
  )
  (begin
    (try! (assert-admin))
    (try! (contract-call? POX5 grant-signer-key signer-key current-contract
      auth-id signer-sig))
    (contract-call? POX5 register-signer signer-manager signer-key)
  )
)

(define-public (pox-claim-rewards
    (bond-periods (list 6 uint))
    (reward-cycle uint)
  )
  (let (
      (trn (get-tranche-count reward-cycle))
      (dist (contract-call? POX5 current-distribution-cycle))
      (last-dist (map-get? last-claim-dist-cycle reward-cycle))
    )

    (asserts! (match last-dist l (> dist l) true) ERR_TRANCHE_TOO_SOON)
    (let (
      (result (try! (contract-call? POX5 claim-rewards bond-periods reward-cycle)))
      (claimed (get total-rewards result))
    )

    (asserts! (> claimed u0) ERR_NO_NEW_REWARDS)

    (map-set stx-pot { reward-cycle: reward-cycle, tranche: trn } claimed)
    (map-set tranche-count reward-cycle (+ trn u1))

    (map-set last-claim-dist-cycle reward-cycle dist)
    (print { topic: "claim-rewards", reward-cycle: reward-cycle,
      tranche: trn, claimed: claimed, dist-cycle: dist,
      fee-bips: (var-get fee-bips) })
    (ok result)
    )
  )
)

(define-map stx-pot { reward-cycle: uint, tranche: uint } uint)

(define-map tranche-count uint uint)

(define-map last-claim-dist-cycle uint uint)

(define-read-only (get-last-claim-dist-cycle (reward-cycle uint))
  (map-get? last-claim-dist-cycle reward-cycle))

(define-map stx-paid { reward-cycle: uint, tranche: uint, staker: principal } uint)

(define-map tranche-paid { reward-cycle: uint, tranche: uint } uint)
(define-map tranche-paid-shares { reward-cycle: uint, tranche: uint } uint)

(define-read-only (get-tranche-count (reward-cycle uint))
  (default-to u0 (map-get? tranche-count reward-cycle)))

(define-read-only (get-stx-pot (reward-cycle uint) (tranche uint))
  (default-to u0 (map-get? stx-pot { reward-cycle: reward-cycle, tranche: tranche })))

(define-read-only (get-stx-paid (reward-cycle uint) (tranche uint) (staker principal))
  (map-get? stx-paid { reward-cycle: reward-cycle, tranche: tranche, staker: staker }))

(define-read-only (get-tranche-paid (reward-cycle uint) (tranche uint))
  (default-to u0 (map-get? tranche-paid { reward-cycle: reward-cycle, tranche: tranche })))

(define-read-only (get-tranche-paid-shares (reward-cycle uint) (tranche uint))
  (default-to u0 (map-get? tranche-paid-shares { reward-cycle: reward-cycle, tranche: tranche })))

(define-read-only (get-cycle-total-shares (reward-cycle uint))
  (contract-call? 'SP000000000000000000002Q6VF78.pox-5 get-signer-shares-staked-for-cycle
    current-contract reward-cycle none))

(define-read-only (get-tranche-residue (reward-cycle uint) (tranche uint))
  (- (get-stx-pot reward-cycle tranche) (get-tranche-paid reward-cycle tranche)))

(define-read-only (is-tranche-fully-paid (reward-cycle uint) (tranche uint))
  (>= (get-tranche-paid-shares reward-cycle tranche)
      (get-cycle-total-shares reward-cycle)))

(define-read-only (get-stx-owed (reward-cycle uint) (tranche uint) (staker principal))
  (let (
      (signer current-contract)
      (total (contract-call? 'SP000000000000000000002Q6VF78.pox-5 get-signer-shares-staked-for-cycle
        signer reward-cycle none))
      (shares (contract-call? 'SP000000000000000000002Q6VF78.pox-5 get-staker-shares-staked-for-cycle
        staker reward-cycle none signer))
    )
    (if (or (is-eq total u0)
            (is-some (map-get? stx-paid
              { reward-cycle: reward-cycle, tranche: tranche, staker: staker })))
      u0

      (let (
          (gross (/ (* (get-stx-pot reward-cycle tranche) shares) total))
          (fee (if (is-og staker)
                 u0
                 (/ (* gross (var-get fee-bips)) MAX_BIPS)))
        )
        (- gross fee)))
  )
)

(define-private (pay-one
    (staker principal)
    (acc { reward-cycle: uint, tranche: uint, pot: uint, total-shares: uint,
           fee: uint, total: uint, fees: uint })
  )
  (let (
      (cycle (get reward-cycle acc))
      (trn (get tranche acc))
      (shares (contract-call? POX5 get-staker-shares-staked-for-cycle
        staker cycle none current-contract))

      (owed (if (is-eq (get total-shares acc) u0)
              u0
              (/ (* (get pot acc) shares) (get total-shares acc))))

      (fee (if (is-og staker) u0 (/ (* owed (get fee acc)) MAX_BIPS)))

      (net (- owed fee))
    )

    (if (or (is-some (map-get? stx-paid
              { reward-cycle: cycle, tranche: trn, staker: staker }))
            (is-eq shares u0))
      acc
      (begin

        (if (> net u0)
          (unwrap-panic (as-contract? ((with-ft SBTC "sbtc-token" net))
            (unwrap-panic (contract-call? SBTC transfer net current-contract staker none))))
          true)
        (if (> fee u0) (var-set earned-fees (+ (var-get earned-fees) fee)) true)

        (map-set stx-paid { reward-cycle: cycle, tranche: trn, staker: staker } net)

        (map-set tranche-paid { reward-cycle: cycle, tranche: trn }
          (+ (get-tranche-paid cycle trn) owed))
        (map-set tranche-paid-shares { reward-cycle: cycle, tranche: trn }
          (+ (get-tranche-paid-shares cycle trn) shares))
        (merge acc { total: (+ (get total acc) net),
                     fees: (+ (get fees acc) fee) })))
  )
)

(define-public (pay-stx-stakers
    (stakers (list 100 principal))
    (reward-cycle uint)
    (tranche uint)
  )
  (let (
      (result (fold pay-one stakers {
        reward-cycle: reward-cycle,
        tranche: tranche,
        pot: (get-stx-pot reward-cycle tranche),
        total-shares: (get-cycle-total-shares reward-cycle),
        fee: (var-get fee-bips),
        total: u0,
        fees: u0,
      }))
      (totl (get total result))
    )
    (print { topic: "pay-stx-stakers", reward-cycle: reward-cycle, tranche: tranche,
      count: (len stakers), total: totl, fees: (get fees result) })
    (ok totl)
  )
)

(define-public (sweep-tranche-dust (reward-cycle uint) (tranche uint))
  (let ((dust (get-tranche-residue reward-cycle tranche)))
    (try! (assert-admin))
    (asserts! (is-tranche-fully-paid reward-cycle tranche) ERR_TRANCHE_UNPAID)
    (asserts! (> dust u0) ERR_NO_DUST)
    (try! (as-contract? ((with-ft SBTC "sbtc-token" dust))
      (try! (contract-call? SBTC transfer dust current-contract
        (var-get admin) none))))
    (map-set tranche-paid { reward-cycle: reward-cycle, tranche: tranche }
      (+ (get-tranche-paid reward-cycle tranche) dust))
    (print { topic: "sweep-tranche-dust", reward-cycle: reward-cycle,
      tranche: tranche, dust: dust })
    (ok dust)
  )
)

(define-private (settle-one
    (staker principal)
    (acc { reward-cycle: uint, bond-index: (optional uint), total: uint, failed: bool })
  )
  (match (contract-call? POX5 claim-staker-rewards-for-signer
            staker (get reward-cycle acc) (get bond-index acc))
    ok-info (merge acc { total: (+ (get total acc) (get earned ok-info)) })
    err-code (merge acc { failed: true })
  )
)

(define-public (pox-settle-stakers
    (stakers (list 100 principal))
    (reward-cycle uint)
    (bond-index (optional uint))
  )
  (let (
      (result (fold settle-one stakers
        { reward-cycle: reward-cycle, bond-index: bond-index, total: u0, failed: false }))
      (totl (get total result))
    )
    (asserts! (not (get failed result)) ERR_SETTLE_FAILED)
    (print { topic: "settle-stakers", reward-cycle: reward-cycle,
      bond-index: bond-index, count: (len stakers), total: totl })
    (ok totl)
  )
)

(define-read-only (get-unclaimed-signer-rewards
    (reward-cycle uint)
    (bond-index (optional uint))
  )
  (contract-call? 'SP000000000000000000002Q6VF78.pox-5 get-signer-unclaimed-rewards-for-cycle
    current-contract reward-cycle bond-index))

(define-read-only (get-staker-entitlement
    (staker principal)
    (reward-cycle uint)
    (bond-index (optional uint))
  )
  (contract-call? 'SP000000000000000000002Q6VF78.pox-5 get-earned-staker-rewards
    current-contract reward-cycle bond-index staker))
