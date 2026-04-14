
export interface GreenhouseJob {
  id: number;
  name: string;
  content?: string;
}

export interface GreenhouseJobPost {
    id: number;
    title: string;
    content: string;
    updated_at: string;
    live: boolean;
}

export interface RateLimitInfo {
  limit: number | null;
  remaining: number | null;
  reset: number | null; // Unix timestamp in seconds
}

export interface GreenhouseApplication {
  id: number;
  candidate_id?: number;
  status?: string;
  jobs?: Array<{ id: number; name: string }>;
  source?: {
    id?: number;
    public_name?: string;
  };
  current_stage?: {
    id?: number;
    name?: string;
  };
  candidate: {
    id: number;
    first_name: string;
    last_name: string;
    email?: string;
    email_addresses?: Array<{
      value?: string;
      address?: string;
    }>;
  };
  attachments: GreenhouseAttachment[];
  [key: string]: any;
}

export interface GreenhouseAttachment {
  filename: string;
  url: string;
  type: 'resume' | 'cover_letter' | 'other' | 'docx';
}


export interface GreenhouseCandidate {
  id: number;
  first_name: string;
  last_name: string;
  attachments: {
    filename: string;
    url: string;
    type: 'resume' | 'cover_letter' | 'other';
  }[];
}

export interface ResumeResult {
    success: boolean;
    fileName: string;
    error?: string;
    url?: string;
    candidateName?: string;
    candidateId?: number;
    candidateEmail?: string;
    applicationId?: number;
    applicationStatus?: string;
    stageName?: string;
    sourceName?: string;
    evaluationSummary?: string;
    status?: 'pending' | 'processing' | 'success' | 'error';
    score?: number;
    fullEvaluation?: string;
    recommendation?: 'strong_interview' | 'interview' | 'review' | 'reject';
    scoreBreakdown?: {
      skillsMatch: number;
      experienceMatch: number;
      domainMatch: number;
      communication: number;
      overallReasoning: number;
    };
    strengths?: string[];
    concerns?: string[];
    authenticityRisk?: 'low' | 'moderate' | 'high';
    authenticitySignals?: string[];
    interviewQuestions?: string[];
    nextStepSuggestion?: string;
    linkedinUrl?: string;
    linkedinDetected?: boolean;
    githubUrl?: string;
    githubDetected?: boolean;
}

export interface CandidateSearchMatch {
    applicationId: number;
    candidateName: string;
    rationale: string;
}

export interface GreenhouseUser {
    id: number;
    name?: string;
    first_name?: string;
    last_name?: string;
    primary_email_address?: string;
    disabled?: boolean;
}

export interface RejectionReason {
    id: number;
    name: string;
}

export interface EmailTemplate {
    id: number;
    name: string;
    type: 'rejection' | 'other';
}
