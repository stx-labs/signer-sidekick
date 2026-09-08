/** Schema-valid v1 receipt; payload summaries deliberately carry no transaction-binding authority. */
export function apiTransactionReceipt(input: {
  txId: string;
  blockHash: string;
  blockHeight: number;
  resultRepr?: string;
  status?: "success" | "abort_by_response" | "abort_by_post_condition";
  sender?: string;
}) {
  return {
    tx_id: input.txId,
    tx_status: input.status ?? "success",
    sender_address: input.sender ?? "ST000000000000000000002AMW42H",
    tx_type: "contract_call",
    contract_call: null,
    post_conditions: [],
    sponsored: false,
    anchor_mode: "any",
    post_condition_mode: "deny",
    tx_result: { hex: "0x0703", repr: input.resultRepr ?? "(ok true)" },
    canonical: true,
    block_hash: input.blockHash,
    block_height: input.blockHeight,
  };
}
