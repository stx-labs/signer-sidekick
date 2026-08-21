import { ArrowClockwise, Check, MagnifyingGlass } from "@phosphor-icons/react";

export function PipelineStage({
  done,
  title,
  value,
  detail,
}: {
  /** `null` means the available snapshot cannot prove completion. */
  done: boolean | null;
  title: string;
  value: string;
  detail: string;
}) {
  const state = done === true ? "done" : done === false ? "active" : "wait";
  return (
    <div className={`stage st-${state}`}>
      <div className="st">
        <span className="ic">
          {done === true ? <Check /> : done === false ? <ArrowClockwise /> : <MagnifyingGlass />}
        </span>
        {title}
      </div>
      <div className="sv">{value}</div>
      <div className="sm">{detail}</div>
    </div>
  );
}
