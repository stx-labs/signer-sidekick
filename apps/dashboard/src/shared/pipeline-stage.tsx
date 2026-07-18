import { ArrowClockwise, Check } from "@phosphor-icons/react";

export function PipelineStage({
  done,
  title,
  value,
  detail,
}: {
  done: boolean;
  title: string;
  value: string;
  detail: string;
}) {
  return (
    <div className={`stage ${done ? "st-done" : "st-active"}`}>
      <div className="st">
        <span className="ic">{done ? <Check /> : <ArrowClockwise />}</span>
        {title}
      </div>
      <div className="sv">{value}</div>
      <div className="sm">{detail}</div>
    </div>
  );
}
