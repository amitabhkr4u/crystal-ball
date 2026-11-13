export type ApprovalType = "Folder" | "Video" | "PDF" | "Image";

export interface Approval {
  id: string;
  title: string;
  type: ApprovalType;
  submittedBy: string;
  status: string;
  statusDate: string;
}

export const approvals: readonly Approval[] = [
  {
    id: "APR-001",
    title: "Site Patrol Onboarding & Checklists",
    type: "Folder",
    submittedBy: "Sam HelpAdmin",
    status: "Pending Review",
    statusDate: "Sep 18"
  },
  {
    id: "APR-002",
    title: "Level 2 Drone Patrol Video Demo",
    type: "Video",
    submittedBy: "Alex HelpAdmin",
    status: "Pending Review",
    statusDate: "Sep 18"
  },
  {
    id: "APR-003",
    title: "Safety Equipment & Sensor Specs",
    type: "PDF",
    submittedBy: "Sam HelpAdmin",
    status: "Pending Review",
    statusDate: "Sep 18"
  },
  {
    id: "APR-004",
    title: "360° Spatial Zone Layout & Camera Map",
    type: "Image",
    submittedBy: "Elena HelpAdmin",
    status: "Pending Review",
    statusDate: "Sep 18"
  }
];

export const policy: string = [
  "Review safety and sensor documents first, onboarding folders second, demonstration videos third, and reference images last unless they change a safety zone.",
  "Folders: verify every checklist is present, current, and opens. Videos: watch the full demo and verify approved procedures and restricted areas. PDFs: verify latest version, complete specifications, page numbers, and sign-offs. Images: verify zone labels and camera positions.",
  "Approve only after every check passes. Request changes for incomplete content. Reject incorrect, outdated, or unsafe content with a reason of at least one sentence. Never approve an item you have not opened.",
  "Escalate unverifiable safety equipment, restricted-area exposure, or conflicts with approved documents to the Safety Lead within one working day. Wait for the response before deciding.",
  "Decide within two working days. Log reviewer, date, and reason."
].join("\n");
