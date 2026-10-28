"use client";
import { AgGridReact } from "ag-grid-react";
import { AllCommunityModule, ModuleRegistry, themeQuartz, colorSchemeDarkBlue, type ColDef } from "ag-grid-community";
import type { LedgerEntry } from "@/lib/types";
ModuleRegistry.registerModules([AllCommunityModule]);
const theme = themeQuartz.withPart(colorSchemeDarkBlue);
const cols: ColDef<LedgerEntry>[] = [
  { field: "at", headerName: "Time", sort: "desc", valueFormatter: (p) => new Date(p.value).toLocaleTimeString(), width: 110 },
  { field: "milestone", filter: true, flex: 1 },
  { field: "event", filter: true, width: 140, cellStyle: (p) => ({ color: p.value === "captured" ? "#2ecc8f" : p.value === "ai_rejected" || p.value === "dispute_opened" ? "#ff6b6b" : "inherit" }) },
  { field: "actor", filter: true, width: 110 },
  { field: "amount", width: 120, type: "rightAligned", aggFunc: "sum", valueFormatter: (p) => (p.value ? `${p.data?.currency} ${Number(p.value).toFixed(2)}` : "") },
  { field: "paypalRef", headerName: "PayPal ref", width: 200 },
  { field: "note", flex: 2, tooltipField: "note" },
];
export default function Ledger({ rows }: { rows: LedgerEntry[] }) {
  return <div className="ledger"><AgGridReact theme={theme} rowData={rows} columnDefs={cols} pagination paginationPageSize={10} paginationPageSizeSelector={[10, 25, 50]} /></div>;
}
