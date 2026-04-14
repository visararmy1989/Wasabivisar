'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Image from 'next/image';
import { AlertCircle as AlertCircleIcon, BarChart3, Bot, Briefcase, CheckCircle2, ChevronLeft, ChevronRight, Clock, Copy, Download, ExternalLink, FileDown, FileType, Inbox, KeyRound, LoaderCircle, Mail, RefreshCw, Save, Search, Send, Sparkles, Upload, Users, XCircle } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import html2canvas from 'html2canvas';
import jsPDF from 'jspdf';

import type { CandidateSearchMatch, EmailTemplate, GreenhouseUser, RateLimitInfo, RejectionReason, ResumeResult } from '@/lib/types';
import {
  addCandidateNote,
  evaluateSingleResume,
  getEmailTemplates,
  getApplicationCandidateId,
  getJobs,
  getJobDetails,
  getLatestJobPost,
  getRejectionReasons,
  getResumesForJob,
  getServerConfigStatus,
  getUsers,
  rejectApplication,
  sendOutreachEmails,
} from '@/app/actions';
import { evaluateResumeWithOpenAI, runCandidateSearchCopilot, validateOpenAIApiKey } from '@/app/openaiActions';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import { RateLimitDisplay } from '@/components/rate-limit-display';

type JobDetails = {
  id: number;
  name: string;
  content?: string;
};

type CandidateBucket = 'top' | 'review' | 'reject' | 'none';

type CandidateMeta = Record<number, { bucket: CandidateBucket; notes: string }>;

type ServerConfigStatus = {
  greenhouseConfigured: boolean;
  openAIConfigured: boolean;
  outreachConfigured?: boolean;
};

const LOCAL_CONTEXT_PREFIX = 'resumeRetriever.context.';
const LOCAL_META_PREFIX = 'resumeRetriever.candidateMeta.';
const LOCAL_OUTREACH_SETTINGS_KEY = 'resumeRetriever.outreachSettings';

const recommendationCopy: Record<NonNullable<ResumeResult['recommendation']>, string> = {
  strong_interview: 'Strong interview',
  interview: 'Interview',
  review: 'Needs review',
  reject: 'Reject',
};

const bucketCopy: Record<CandidateBucket, string> = {
  top: 'Top picks',
  review: 'Needs review',
  reject: 'Reject',
  none: 'Unsorted',
};

function getGreenhouseUserLabel(user: GreenhouseUser) {
  return user.name || `${user.first_name || ''} ${user.last_name || ''}`.trim() || user.primary_email_address || `User ${user.id}`;
}

function getScoreTone(score?: number) {
  if (typeof score !== 'number') {
    return 'text-slate-500 bg-slate-100';
  }

  if (score >= 8) {
    return 'text-emerald-700 bg-emerald-100';
  }

  if (score >= 6) {
    return 'text-amber-700 bg-amber-100';
  }

  return 'text-rose-700 bg-rose-100';
}

function getRecommendationTone(recommendation?: ResumeResult['recommendation']) {
  switch (recommendation) {
    case 'strong_interview':
      return 'bg-emerald-100 text-emerald-700 border-emerald-200';
    case 'interview':
      return 'bg-sky-100 text-sky-700 border-sky-200';
    case 'review':
      return 'bg-amber-100 text-amber-700 border-amber-200';
    case 'reject':
      return 'bg-rose-100 text-rose-700 border-rose-200';
    default:
      return 'bg-slate-100 text-slate-700 border-slate-200';
  }
}

function getStatusTone(status?: ResumeResult['status']) {
  switch (status) {
    case 'success':
      return 'border-emerald-200 bg-emerald-50 text-emerald-700';
    case 'processing':
      return 'border-sky-200 bg-sky-50 text-sky-700';
    case 'error':
      return 'border-rose-200 bg-rose-50 text-rose-700';
    default:
      return 'border-slate-200 bg-slate-50 text-slate-600';
  }
}

function getAuthenticityTone(risk?: ResumeResult['authenticityRisk']) {
  switch (risk) {
    case 'low':
      return 'border-emerald-200 bg-emerald-50 text-emerald-700';
    case 'high':
      return 'border-rose-200 bg-rose-50 text-rose-700';
    case 'moderate':
    default:
      return 'border-amber-200 bg-amber-50 text-amber-700';
  }
}

function mentionShortLabel(label: string) {
  return label.length > 28 ? `${label.slice(0, 28)}...` : label;
}

function stripHtmlTags(value?: string) {
  return (value || '').replace(/<[^>]+>/g, ' ');
}

function parseKeywordSearchTerms(query: string) {
  const normalized = query.trim();
  if (!normalized) {
    return [];
  }

  const prefixMatch = normalized.match(/^(keywords?|skills?)\s*:\s*(.+)$/i);
  const rawTerms = prefixMatch ? prefixMatch[2] : normalized;

  const hasCommaSeparatedTerms = rawTerms.includes(',');
  const hasBooleanJoiner = /\b(and|or)\b/i.test(rawTerms);
  const looksLikeSimpleKeywordQuery =
    hasCommaSeparatedTerms ||
    (/^[\w\s/+.-]+$/.test(rawTerms) && rawTerms.split(/\s+/).length <= 4 && !/[?]/.test(rawTerms));

  if (!looksLikeSimpleKeywordQuery) {
    return [];
  }

  return rawTerms
    .split(/,|\band\b|\bor\b/gi)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2);
}

function SummaryMetric({
  label,
  value,
  hint,
  tone = 'light',
}: {
  label: string;
  value: string;
  hint: string;
  tone?: 'light' | 'dark';
}) {
  return (
    <Card
      className={
        tone === 'dark'
          ? 'border-white/55 bg-[linear-gradient(180deg,_rgba(255,255,255,0.78),_rgba(236,241,255,0.64))] shadow-[0_18px_40px_-28px_rgba(0,0,0,0.75)] backdrop-blur'
          : 'border-white/60 bg-white/80 shadow-sm backdrop-blur'
      }
    >
      <CardContent className="p-5">
        <p className={`text-xs uppercase tracking-[0.2em] ${tone === 'dark' ? 'text-slate-700' : 'text-muted-foreground'}`}>{label}</p>
        <p className={`mt-3 text-3xl font-semibold ${tone === 'dark' ? 'text-slate-950' : 'text-slate-900'}`}>{value}</p>
        <p className={`mt-2 text-sm ${tone === 'dark' ? 'text-slate-700' : 'text-muted-foreground'}`}>{hint}</p>
      </CardContent>
    </Card>
  );
}

function ResumePreviewDialog({
  url,
  fileName,
}: {
  url: string;
  fileName: string;
}) {
  const lowerName = fileName.toLowerCase();
  const isBrowserPreviewable =
    lowerName.endsWith('.pdf') ||
    lowerName.endsWith('.txt') ||
    lowerName.endsWith('.html') ||
    lowerName.endsWith('.htm');
  const [previewFailed, setPreviewFailed] = useState(false);

  useEffect(() => {
    setPreviewFailed(false);
  }, [url, fileName]);

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="border-[#42C74A]/20 hover:bg-[#42C74A]/8">
          <ExternalLink className="mr-2 h-4 w-4" />
          Resume
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-5xl p-0 overflow-hidden">
        <DialogHeader className="border-b bg-slate-50/80 px-6 py-5">
          <DialogTitle className="text-xl">Resume Preview</DialogTitle>
          <DialogDescription>{fileName}</DialogDescription>
        </DialogHeader>
        {isBrowserPreviewable && !previewFailed ? (
          <div className="h-[78vh] bg-slate-100">
            <iframe
              src={url}
              title={`Resume preview for ${fileName}`}
              className="h-full w-full border-0"
              onError={() => setPreviewFailed(true)}
            />
          </div>
        ) : (
          <div className="space-y-3 px-6 py-8">
            <p className="text-sm text-slate-700">
              {previewFailed
                ? 'This resume could not be previewed inline from the source file URL.'
                : 'This resume format does not preview reliably inside the browser without triggering a file download.'}
            </p>
            <p className="text-sm text-slate-600">
              Supported inline preview formats are typically PDF and text-based files. Some attachment servers also block embedded preview even for PDFs.
            </p>
            <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
              For compliance-friendly review, use the AI evaluation, strengths, risks, and interview kit in the app. This avoids forced downloads when the resume file cannot be embedded safely.
            </div>
            <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
              File: <span className="font-medium">{fileName}</span>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function EvaluationViewer({
  result,
  notes,
  bucket,
  greenhouseUsers,
  outreachConfigured,
  notifyTaggedTeammate,
  noteAuthorId,
  taggedUserId,
  onNotesChange,
  onBucketChange,
  onNoteAuthorChange,
  onTaggedUserChange,
  onNotifyTaggedTeammateChange,
  onSaveGreenhouseNote,
  onExportPdf,
  canGoPrevious,
  canGoNext,
  onPrevious,
  onNext,
  open,
  onOpenChange,
}: {
  result: ResumeResult;
  notes: string;
  bucket: CandidateBucket;
  greenhouseUsers: GreenhouseUser[];
  outreachConfigured: boolean;
  notifyTaggedTeammate: boolean;
  noteAuthorId: string;
  taggedUserId: string;
  onNotesChange: (notes: string) => void;
  onBucketChange: (bucket: CandidateBucket) => void;
  onNoteAuthorChange: (userId: string) => void;
  onTaggedUserChange: (userId: string) => void;
  onNotifyTaggedTeammateChange: (checked: boolean) => void;
  onSaveGreenhouseNote: () => Promise<void>;
  onExportPdf: () => void;
  canGoPrevious: boolean;
  canGoNext: boolean;
  onPrevious: () => void;
  onNext: () => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const recommendation = result.recommendation ? recommendationCopy[result.recommendation] : 'Not available';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Bot className="mr-2 h-4 w-4" />
          Review
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-6xl p-0 overflow-hidden">
        <div className="grid max-h-[88vh] grid-cols-1 lg:grid-cols-[1.25fr_0.75fr]">
          <div className="border-b bg-white lg:border-b-0 lg:border-r">
            <DialogHeader className="border-b bg-slate-50/80 px-6 py-5">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <DialogTitle className="text-2xl">{result.candidateName}</DialogTitle>
                  <p className="text-xs text-muted-foreground">
                    Candidate ID: {result.candidateId ?? 'Unavailable'} · Application ID: {result.applicationId ?? 'Unavailable'}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Button type="button" variant="outline" size="icon" onClick={onPrevious} disabled={!canGoPrevious}>
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
                  <Button type="button" variant="outline" size="icon" onClick={onNext} disabled={!canGoNext}>
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              <div className="text-sm text-muted-foreground flex flex-wrap items-center gap-2 pt-2">
                <Badge variant="outline">{result.stageName || 'Unknown stage'}</Badge>
                {result.sourceName && result.sourceName.toLowerCase() !== 'linkedin' ? (
                  <Badge variant="outline">{result.sourceName}</Badge>
                ) : null}
                {result.linkedinUrl ? (
                  <a href={result.linkedinUrl} target="_blank" rel="noopener noreferrer">
                    <Badge variant="outline" className="cursor-pointer transition hover:border-sky-300 hover:bg-sky-50 hover:text-sky-700">
                      LinkedIn
                    </Badge>
                  </a>
                ) : result.linkedinDetected ? (
                  <Badge variant="outline" className="border-sky-200 bg-sky-50 text-sky-700">
                    LinkedIn listed in resume
                  </Badge>
                ) : (
                  <Badge variant="outline" className="border-slate-200 bg-slate-50 text-slate-500">
                    No LinkedIn
                  </Badge>
                )}
                {result.githubUrl ? (
                  <a href={result.githubUrl} target="_blank" rel="noopener noreferrer">
                    <Badge variant="outline" className="cursor-pointer transition hover:border-slate-400 hover:bg-slate-100 hover:text-slate-800">
                      GitHub
                    </Badge>
                  </a>
                ) : result.githubDetected ? (
                  <Badge variant="outline" className="border-slate-300 bg-slate-100 text-slate-700">
                    GitHub listed in resume
                  </Badge>
                ) : (
                  <Badge variant="outline" className="border-slate-200 bg-slate-50 text-slate-500">
                    No GitHub
                  </Badge>
                )}
                <Badge className={getRecommendationTone(result.recommendation)}>
                  {recommendation}
                </Badge>
                {result.authenticityRisk && (
                  <Badge variant="outline" className={getAuthenticityTone(result.authenticityRisk)}>
                    {result.authenticityRisk === 'high' ? 'Verify carefully' : `${result.authenticityRisk} authenticity risk`}
                  </Badge>
                )}
              </div>
            </DialogHeader>
            <ScrollArea className="h-[70vh] px-6 py-5">
              <div className="space-y-6">
                <div className="flex flex-wrap items-center gap-3">
                  <div className={`rounded-full px-4 py-2 text-sm font-semibold ${getScoreTone(result.score)}`}>
                    Score {typeof result.score === 'number' ? `${result.score}/10` : 'N/A'}
                  </div>
                  {result.nextStepSuggestion && (
                    <p className="text-sm text-slate-600">{result.nextStepSuggestion}</p>
                  )}
                </div>

                <div className="grid gap-2 grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
                  {result.scoreBreakdown && Object.entries(result.scoreBreakdown).map(([key, value]) => (
                    <Card key={key} className="border-slate-200 bg-slate-50/80 shadow-none">
                      <CardContent className="p-3">
                        <p className="break-words text-[10px] uppercase leading-tight tracking-[0.1em] text-muted-foreground sm:text-[11px]">
                          {key.replace(/([A-Z])/g, ' $1').trim()}
                        </p>
                        <p className="mt-1.5 text-xl font-semibold text-slate-900 sm:text-2xl">{value}/10</p>
                      </CardContent>
                    </Card>
                  ))}
                </div>

                <div className="grid gap-4 lg:grid-cols-2">
                  <Card className="border-emerald-100 bg-emerald-50/70 shadow-none">
                    <CardHeader className="pb-3">
                      <CardTitle className="text-base text-emerald-900">Strengths</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <ul className="space-y-2 text-sm text-emerald-950">
                        {(result.strengths || []).map((item) => (
                          <li key={item} className="rounded-md bg-white/80 px-3 py-2">{item}</li>
                        ))}
                      </ul>
                    </CardContent>
                  </Card>
                  <Card className="border-amber-100 bg-amber-50/70 shadow-none">
                    <CardHeader className="pb-3">
                      <CardTitle className="text-base text-amber-900">Risks And Gaps</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <ul className="space-y-2 text-sm text-amber-950">
                        {(result.concerns || []).map((item) => (
                          <li key={item} className="rounded-md bg-white/80 px-3 py-2">{item}</li>
                        ))}
                      </ul>
                    </CardContent>
                  </Card>
                </div>

                {result.authenticitySignals && result.authenticitySignals.length > 0 && (
                  <Card className="border-rose-100 bg-rose-50/70 shadow-none">
                    <CardHeader className="pb-3">
                      <CardTitle className="text-base text-rose-900">Verification Signals</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <ul className="space-y-2 text-sm text-rose-950">
                        {result.authenticitySignals.map((item) => (
                          <li key={item} className="rounded-md bg-white/80 px-3 py-2">{item}</li>
                        ))}
                      </ul>
                    </CardContent>
                  </Card>
                )}

                {result.fullEvaluation && (
                  <Card className="border-slate-200 shadow-none">
                    <CardHeader className="pb-3">
                      <CardTitle className="text-base">Detailed Evaluation</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <div
                        className="prose prose-slate max-w-none"
                        dangerouslySetInnerHTML={{ __html: result.fullEvaluation }}
                      />
                    </CardContent>
                  </Card>
                )}
              </div>
            </ScrollArea>
          </div>

          <ScrollArea className="h-[70vh] bg-slate-50/60">
            <div className="px-6 py-5">
            <div className="space-y-5">
              <div>
                <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Recruiter Workflow</p>
                <h3 className="mt-2 text-xl font-semibold text-slate-900">Decision Support</h3>
              </div>

              <Card className="border-white/70 bg-white/90 shadow-sm">
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">Shortlist Bucket</CardTitle>
                </CardHeader>
                <CardContent>
                  <Select value={bucket} onValueChange={(value) => onBucketChange(value as CandidateBucket)}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="top">Top picks</SelectItem>
                      <SelectItem value="review">Needs review</SelectItem>
                      <SelectItem value="reject">Reject</SelectItem>
                      <SelectItem value="none">Unsorted</SelectItem>
                    </SelectContent>
                  </Select>
                </CardContent>
              </Card>

              <Card className="border-white/70 bg-white/90 shadow-sm">
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">Recruiter Notes</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="space-y-2">
                    <Label>Save note as</Label>
                    <Select value={noteAuthorId} onValueChange={onNoteAuthorChange}>
                      <SelectTrigger>
                        <SelectValue placeholder="Select Greenhouse user" />
                      </SelectTrigger>
                      <SelectContent>
                        {greenhouseUsers.map((user) => (
                          <SelectItem key={user.id} value={String(user.id)}>
                            {getGreenhouseUserLabel(user)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>Tag teammate in note</Label>
                    <Select value={taggedUserId} onValueChange={onTaggedUserChange}>
                      <SelectTrigger>
                        <SelectValue placeholder="Optional teammate mention" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">No teammate tag</SelectItem>
                        {greenhouseUsers.map((user) => (
                          <SelectItem key={user.id} value={String(user.id)}>
                            {getGreenhouseUserLabel(user)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex items-start gap-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-3">
                    <Checkbox
                      id={`notify-tagged-${result.applicationId ?? result.candidateId ?? 'candidate'}`}
                      checked={notifyTaggedTeammate}
                      onCheckedChange={(checked) => onNotifyTaggedTeammateChange(checked === true)}
                      disabled={!outreachConfigured}
                    />
                    <div className="space-y-1">
                      <Label
                        htmlFor={`notify-tagged-${result.applicationId ?? result.candidateId ?? 'candidate'}`}
                        className="text-sm font-medium text-slate-900"
                      >
                        Also notify tagged teammate by email
                      </Label>
                      <p className="text-xs text-slate-600">
                        {outreachConfigured
                          ? 'After the Greenhouse note saves, the app will email the tagged teammate too.'
                          : 'Configure RESEND_API_KEY and OUTREACH_FROM_EMAIL on the server to enable teammate email notifications.'}
                      </p>
                    </div>
                  </div>
                  <Textarea
                    value={notes}
                    onChange={(event) => onNotesChange(event.target.value)}
                    placeholder="Write recruiter context or ask a teammate to review."
                    className="min-h-32"
                  />
                  <Button variant="outline" className="w-full" onClick={onSaveGreenhouseNote}>
                    <Save className="mr-2 h-4 w-4" />
                    Save Note To Greenhouse
                  </Button>
                </CardContent>
              </Card>

              <Card className="border-white/70 bg-white/90 shadow-sm">
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">Interview Kit</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {(result.interviewQuestions || []).map((question, index) => (
                    <div key={`${question}-${index}`} className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-3 text-sm text-slate-700">
                      {question}
                    </div>
                  ))}
                </CardContent>
                <CardFooter>
                  <Button variant="outline" className="w-full" onClick={onExportPdf}>
                    <FileType className="mr-2 h-4 w-4" />
                    Export Review Pack
                  </Button>
                </CardFooter>
              </Card>
            </div>
            </div>
          </ScrollArea>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function CandidateCompareDialog({
  candidates,
}: {
  candidates: ResumeResult[];
}) {
  if (candidates.length < 2) {
    return null;
  }

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline">
          <Users className="mr-2 h-4 w-4" />
          Compare Selected
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-6xl">
        <DialogHeader>
          <DialogTitle>Candidate Comparison</DialogTitle>
          <DialogDescription>Side-by-side signal comparison for final recruiter review.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 lg:grid-cols-2">
          {candidates.slice(0, 2).map((candidate) => (
            <Card key={candidate.applicationId} className="border-slate-200">
              <CardHeader>
                <CardTitle className="text-xl">{candidate.candidateName}</CardTitle>
                <CardDescription className="flex flex-wrap gap-2">
                  <Badge className={getRecommendationTone(candidate.recommendation)}>
                    {candidate.recommendation ? recommendationCopy[candidate.recommendation] : 'No recommendation'}
                  </Badge>
                  <Badge variant="outline">{candidate.stageName || 'Unknown stage'}</Badge>
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className={`inline-flex rounded-full px-4 py-2 text-sm font-semibold ${getScoreTone(candidate.score)}`}>
                  Score {typeof candidate.score === 'number' ? `${candidate.score}/10` : 'N/A'}
                </div>
                <div>
                  <p className="mb-2 text-sm font-medium text-slate-900">Summary</p>
                  <p className="text-sm text-slate-600">{candidate.evaluationSummary || 'No summary available.'}</p>
                </div>
                <div>
                  <p className="mb-2 text-sm font-medium text-slate-900">Strengths</p>
                  <ul className="space-y-2 text-sm text-slate-600">
                    {(candidate.strengths || []).map((item) => (
                      <li key={item} className="rounded-md bg-slate-50 px-3 py-2">{item}</li>
                    ))}
                  </ul>
                </div>
                <div>
                  <p className="mb-2 text-sm font-medium text-slate-900">Concerns</p>
                  <ul className="space-y-2 text-sm text-slate-600">
                    {(candidate.concerns || []).map((item) => (
                      <li key={item} className="rounded-md bg-slate-50 px-3 py-2">{item}</li>
                    ))}
                  </ul>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function ResumeRetriever() {
  const [greenhouseApiKey, setGreenhouseApiKey] = useState('');
  const [openAIApiKey, setOpenAIApiKey] = useState('');
  const [serverConfig, setServerConfig] = useState<ServerConfigStatus>({
    greenhouseConfigured: false,
    openAIConfigured: false,
  });
  const [jobs, setJobs] = useState<JobDetails[]>([]);
  const [greenhouseUsers, setGreenhouseUsers] = useState<GreenhouseUser[]>([]);
  const [selectedNoteAuthorId, setSelectedNoteAuthorId] = useState('');
  const [taggedUserByApplication, setTaggedUserByApplication] = useState<Record<number, string>>({});
  const [notifyTaggedTeammate, setNotifyTaggedTeammate] = useState(false);
  const [selectedJobId, setSelectedJobId] = useState('');
  const [selectedJobDetails, setSelectedJobDetails] = useState<JobDetails | null>(null);
  const [liveJobPostContent, setLiveJobPostContent] = useState<string | null>(null);
  const [applicationStatusFilter, setApplicationStatusFilter] = useState('all');
  const [searchTerm, setSearchTerm] = useState('');
  const [aiSearchQuery, setAiSearchQuery] = useState('');
  const [aiSearchSummary, setAiSearchSummary] = useState('');
  const [aiSearchMatches, setAiSearchMatches] = useState<CandidateSearchMatch[]>([]);
  const [showOnlyAiMatches, setShowOnlyAiMatches] = useState(false);
  const [recommendationFilter, setRecommendationFilter] = useState('all');
  const [bucketFilter, setBucketFilter] = useState('all');
  const [stageFilter, setStageFilter] = useState('all');
  const [candidateMeta, setCandidateMeta] = useState<CandidateMeta>({});
  const [selectedCandidates, setSelectedCandidates] = useState<Set<number>>(new Set());
  const [resumeResults, setResumeResults] = useState<ResumeResult[]>([]);
  const [rejectionReasons, setRejectionReasons] = useState<RejectionReason[]>([]);
  const [emailTemplates, setEmailTemplates] = useState<EmailTemplate[]>([]);
  const [selectedRejectionReason, setSelectedRejectionReason] = useState('');
  const [selectedEmailTemplate, setSelectedEmailTemplate] = useState('-1');
  const [singleResumeFile, setSingleResumeFile] = useState<File | null>(null);
  const [singleEvalResult, setSingleEvalResult] = useState<ResumeResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isFetchingJobDetails, setIsFetchingJobDetails] = useState(false);
  const [isFetchingResumes, setIsFetchingResumes] = useState(false);
  const [isEvaluatingSingle, setIsEvaluatingSingle] = useState(false);
  const [isSendingRejections, setIsSendingRejections] = useState(false);
  const [isValidatingOpenAIKey, setIsValidatingOpenAIKey] = useState(false);
  const [isRunningAiSearch, setIsRunningAiSearch] = useState(false);
  const [processCompleted, setProcessCompleted] = useState(false);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState('Configure your API access to begin.');
  const [rateLimit, setRateLimit] = useState<RateLimitInfo | null>(null);
  const [showAccessSetup, setShowAccessSetup] = useState(true);
  const [isGreenhouseConnected, setIsGreenhouseConnected] = useState(false);
  const [recruiterName, setRecruiterName] = useState('Recruiting Team');
  const [recruiterTitle, setRecruiterTitle] = useState('Talent Acquisition');
  const [calendarLink, setCalendarLink] = useState('');
  const [outreachTemplate, setOutreachTemplate] = useState(
    'Hi {{candidateFirstName}},\n\nWe enjoyed reviewing your background for the {{jobTitle}} role at Wasabi Technologies. Your experience stood out and we would love to connect for a short intro call.\n\nYou can pick a time that works for you here: {{calendarLink}}\n\n{{personalizedLine}}\n\nBest,\n{{recruiterName}}\n{{recruiterTitle}}\nWasabi Technologies'
  );
  const [isSendingOutreach, setIsSendingOutreach] = useState(false);
  const [activeReviewApplicationId, setActiveReviewApplicationId] = useState<number | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const evaluationRunIdRef = useRef(0);
  const stopEvaluationRef = useRef(false);
  const { toast } = useToast();

  const trimmedOpenAIApiKey = openAIApiKey.trim();
  const isOpenAIReady = serverConfig.openAIConfigured || !!trimmedOpenAIApiKey;

  const storageKeyForMeta = selectedJobId ? `${LOCAL_META_PREFIX}${selectedJobId}` : '';

  useEffect(() => {
    const loadServerConfig = async () => {
      const config = await getServerConfigStatus();
      setServerConfig(config);
      setNotifyTaggedTeammate(Boolean(config.outreachConfigured));

      if (config.greenhouseConfigured) {
        await handleConnect('');
      }
    };

    void loadServerConfig();
  }, []);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(LOCAL_OUTREACH_SETTINGS_KEY);
      if (!stored) {
        return;
      }

      const parsed = JSON.parse(stored) as {
        recruiterName?: string;
        recruiterTitle?: string;
        calendarLink?: string;
        outreachTemplate?: string;
      };

      if (parsed.recruiterName) setRecruiterName(parsed.recruiterName);
      if (parsed.recruiterTitle) setRecruiterTitle(parsed.recruiterTitle);
      if (parsed.calendarLink) setCalendarLink(parsed.calendarLink);
      if (parsed.outreachTemplate) setOutreachTemplate(parsed.outreachTemplate);
    } catch (error) {
      console.error('Failed to load outreach settings', error);
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(LOCAL_OUTREACH_SETTINGS_KEY, JSON.stringify({
        recruiterName,
        recruiterTitle,
        calendarLink,
        outreachTemplate,
      }));
    } catch (error) {
      console.error('Failed to save outreach settings', error);
    }
  }, [calendarLink, outreachTemplate, recruiterName, recruiterTitle]);

  useEffect(() => {
    if (!storageKeyForMeta) {
      setCandidateMeta({});
      return;
    }

    try {
      const stored = localStorage.getItem(storageKeyForMeta);
      setCandidateMeta(stored ? JSON.parse(stored) : {});
    } catch (error) {
      console.error('Failed to load candidate meta', error);
      setCandidateMeta({});
    }
  }, [storageKeyForMeta]);

  useEffect(() => {
    if (!storageKeyForMeta) {
      return;
    }

    try {
      localStorage.setItem(storageKeyForMeta, JSON.stringify(candidateMeta));
    } catch (error) {
      console.error('Failed to persist candidate meta', error);
    }
  }, [candidateMeta, storageKeyForMeta]);

  useEffect(() => {
    if (aiSearchQuery.trim()) {
      return;
    }

    if (aiSearchSummary || aiSearchMatches.length > 0 || showOnlyAiMatches) {
      setAiSearchSummary('');
      setAiSearchMatches([]);
      setShowOnlyAiMatches(false);
    }
  }, [aiSearchMatches.length, aiSearchQuery, aiSearchSummary, showOnlyAiMatches]);

  const stageOptions = useMemo(() => {
    return Array.from(new Set(resumeResults.map((result) => result.stageName).filter(Boolean))) as string[];
  }, [resumeResults]);

  const enrichedResults = useMemo(() => {
    return resumeResults.map((result) => {
      const meta = result.applicationId ? candidateMeta[result.applicationId] : undefined;
      return {
        ...result,
        bucket: meta?.bucket || 'none',
        notes: meta?.notes || '',
      };
    });
  }, [candidateMeta, resumeResults]);

  const aiMatchedIds = useMemo(() => new Set(aiSearchMatches.map((match) => match.applicationId)), [aiSearchMatches]);

  const filteredResults = useMemo(() => {
    return enrichedResults.filter((result) => {
      const matchesSearch = !searchTerm || `${result.candidateName || ''} ${result.fileName} ${result.stageName || ''} ${result.sourceName || ''}`.toLowerCase().includes(searchTerm.toLowerCase());
      const matchesRecommendation = recommendationFilter === 'all' || result.recommendation === recommendationFilter;
      const matchesBucket = bucketFilter === 'all' || result.bucket === bucketFilter;
      const matchesStage = stageFilter === 'all' || result.stageName === stageFilter;
      const matchesAiSearch = !showOnlyAiMatches || (result.applicationId ? aiMatchedIds.has(result.applicationId) : false);
      return matchesSearch && matchesRecommendation && matchesBucket && matchesStage && matchesAiSearch;
    });
  }, [aiMatchedIds, bucketFilter, enrichedResults, recommendationFilter, searchTerm, showOnlyAiMatches, stageFilter]);

  const rankedResults = useMemo(() => {
    return [...filteredResults].sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  }, [filteredResults]);

  const topCandidates = useMemo(() => rankedResults.filter((result) => typeof result.score === 'number').slice(0, 3), [rankedResults]);

  const compareCandidates = useMemo(() => {
    return enrichedResults.filter((result) => result.applicationId && selectedCandidates.has(result.applicationId) && result.status === 'success');
  }, [enrichedResults, selectedCandidates]);

  const outreachCandidates = useMemo(() => {
    const selected = enrichedResults.filter((result) => result.applicationId && selectedCandidates.has(result.applicationId));
    const topBucketCandidates = enrichedResults.filter((result) => result.bucket === 'top');
    const source = selected.length > 0 ? selected : topBucketCandidates;
    return source.filter((result, index, array) => array.findIndex((item) => item.applicationId === result.applicationId) === index);
  }, [enrichedResults, selectedCandidates]);

  const metrics = useMemo(() => {
    const scored = enrichedResults.filter((result) => typeof result.score === 'number');
    const averageScore = scored.length > 0 ? (scored.reduce((sum, result) => sum + (result.score || 0), 0) / scored.length).toFixed(1) : '0.0';
    const interviewReady = enrichedResults.filter((result) => result.recommendation === 'strong_interview' || result.recommendation === 'interview').length;
    const topBucket = enrichedResults.filter((result) => result.bucket === 'top').length;

    return {
      total: enrichedResults.length,
      scored: scored.length,
      averageScore,
      interviewReady,
      topBucket,
    };
  }, [enrichedResults]);

  function getCandidateFirstName(candidateName?: string) {
    return candidateName?.split(' ')[0] || 'there';
  }

  const reviewableResults = useMemo(
    () => rankedResults.filter((result) => result.status === 'success' && result.fullEvaluation && result.applicationId),
    [rankedResults]
  );

  const activeReviewIndex = useMemo(
    () => reviewableResults.findIndex((result) => result.applicationId === activeReviewApplicationId),
    [activeReviewApplicationId, reviewableResults]
  );

  function openReviewForCandidate(applicationId?: number) {
    if (!applicationId) {
      return;
    }
    setActiveReviewApplicationId(applicationId);
  }

  function goToAdjacentReview(direction: 'previous' | 'next') {
    if (activeReviewIndex < 0) {
      return;
    }

    const nextIndex = direction === 'previous' ? activeReviewIndex - 1 : activeReviewIndex + 1;
    const target = reviewableResults[nextIndex];
    if (!target?.applicationId) {
      return;
    }

    setActiveReviewApplicationId(target.applicationId);
  }

  function clearScreeningSession(options?: { keepSelectedJob?: boolean }) {
    evaluationRunIdRef.current += 1;
    stopEvaluationRef.current = false;
    setResumeResults([]);
    setAiSearchQuery('');
    setAiSearchSummary('');
    setAiSearchMatches([]);
    setShowOnlyAiMatches(false);
    setSelectedCandidates(new Set());
    setSingleEvalResult(null);
    setProgress(0);
    setProcessCompleted(false);
    setStatus(options?.keepSelectedJob ? 'Review reset. Ready for a new run.' : 'Choose a job to begin.');
    setSearchTerm('');
    setRecommendationFilter('all');
    setBucketFilter('all');
    setStageFilter('all');
    setIsFetchingResumes(false);

    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }

    if (!options?.keepSelectedJob) {
      setSelectedJobId('');
      setSelectedJobDetails(null);
      setLiveJobPostContent(null);
      setCandidateMeta({});
    }
  }

  function handleStopScreening() {
    if (!isFetchingResumes) {
      return;
    }

    stopEvaluationRef.current = true;
    evaluationRunIdRef.current += 1;
    setIsFetchingResumes(false);
    setProcessCompleted(true);
    setStatus('Screening stopped. You can retry failed candidates, reset, or switch jobs.');
    toast({
      title: 'Screening stopped',
      description: 'The current evaluation run was stopped. Finished results were kept.',
    });
  }

  function handleResetReview() {
    clearScreeningSession({ keepSelectedJob: true });
    toast({
      title: 'Review reset',
      description: 'Cleared the current screening results for this job.',
    });
  }

  function handleStartNewJob() {
    clearScreeningSession({ keepSelectedJob: false });
    toast({
      title: 'Ready for a new job',
      description: 'Previous screening results were cleared. Choose a different job to continue.',
    });
  }

  function buildOutreachMessage(result: ResumeResult) {
    const personalizedLine = result.evaluationSummary
      ? `A quick note on why we reached out: ${result.evaluationSummary}`
      : 'We think your background could be a strong fit for what the team is building.';

    return outreachTemplate
      .replaceAll('{{candidateFirstName}}', getCandidateFirstName(result.candidateName))
      .replaceAll('{{jobTitle}}', selectedJobDetails?.name || 'this role')
      .replaceAll('{{calendarLink}}', calendarLink || '[add your scheduling link]')
      .replaceAll('{{recruiterName}}', recruiterName || 'Recruiting Team')
      .replaceAll('{{recruiterTitle}}', recruiterTitle || 'Talent Acquisition')
      .replaceAll('{{personalizedLine}}', personalizedLine);
  }

  function buildOutreachSubject(result: ResumeResult) {
    return `Wasabi Technologies | ${selectedJobDetails?.name || 'Intro call'} follow-up for ${getCandidateFirstName(result.candidateName)}`;
  }

  async function handleConnect(key: string) {
    setIsLoading(true);
    setStatus('Connecting to Greenhouse and loading open jobs...');
    setProgress(20);

    const result = await getJobs(key);
    setRateLimit(result.rateLimit ?? null);

    if (!result.success || !result.jobs) {
      setIsGreenhouseConnected(false);
      setStatus(result.error || 'Failed to connect to Greenhouse.');
      toast({
        variant: 'destructive',
        title: 'Connection failed',
        description: result.error || 'Unable to fetch jobs.',
      });
      setIsLoading(false);
      setProgress(0);
      return;
    }

    setJobs(result.jobs);
    setGreenhouseApiKey(key);
    setIsGreenhouseConnected(true);
    setShowAccessSetup(false);
    setStatus('Connected. Choose a job to begin screening.');
    setProgress(0);
    setIsLoading(false);

    const usersResult = await getUsers(key);
    if (usersResult.success && usersResult.users) {
      setGreenhouseUsers(usersResult.users);
      if (!selectedNoteAuthorId && usersResult.users.length > 0) {
        setSelectedNoteAuthorId(String(usersResult.users[0].id));
      }
    }

    toast({
      title: 'Greenhouse connected',
      description: `Loaded ${result.jobs.length} open job${result.jobs.length === 1 ? '' : 's'}.`,
    });
  }

  async function fetchRejectionData(activeKey: string) {
    const [reasonsResult, templatesResult] = await Promise.all([
      getRejectionReasons(activeKey),
      getEmailTemplates(activeKey),
    ]);

    if (reasonsResult.success && reasonsResult.reasons) {
      setRejectionReasons(reasonsResult.reasons);
    }

    if (templatesResult.success && templatesResult.templates) {
      setEmailTemplates(templatesResult.templates);
    }
  }

  async function handleJobSelection(jobId: string) {
    evaluationRunIdRef.current += 1;
    stopEvaluationRef.current = false;
    setSelectedJobId(jobId);
    setSelectedJobDetails(null);
    setLiveJobPostContent(null);
    setResumeResults([]);
    setAiSearchQuery('');
    setAiSearchSummary('');
    setAiSearchMatches([]);
    setShowOnlyAiMatches(false);
    setSingleEvalResult(null);
    setSelectedCandidates(new Set());
    setProcessCompleted(false);
    setSearchTerm('');
    setRecommendationFilter('all');
    setBucketFilter('all');
    setStageFilter('all');

    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }

    if (!jobId) {
      return;
    }

    setIsFetchingJobDetails(true);
    const [detailsResult, livePostResult] = await Promise.all([
      getJobDetails(Number(jobId), greenhouseApiKey),
      getLatestJobPost(Number(jobId), greenhouseApiKey),
    ]);

    try {
      const storedContext = localStorage.getItem(`${LOCAL_CONTEXT_PREFIX}${jobId}`);
      if (storedContext) {
        const jobName = jobs.find((job) => job.id === Number(jobId))?.name || '';
        setSelectedJobDetails({ id: Number(jobId), name: jobName, content: storedContext });
      } else if (detailsResult.success && detailsResult.job) {
        setSelectedJobDetails(detailsResult.job);
      }
    } catch (error) {
      console.error('Failed to load local job context', error);
    }

    if (livePostResult.success && livePostResult.content) {
      setLiveJobPostContent(livePostResult.content);
    }

    setRateLimit(livePostResult.rateLimit ?? detailsResult.rateLimit ?? null);
    setIsFetchingJobDetails(false);

    await fetchRejectionData(greenhouseApiKey);
  }

  function saveJobContext() {
    if (!selectedJobDetails?.id) {
      return;
    }

    try {
      localStorage.setItem(`${LOCAL_CONTEXT_PREFIX}${selectedJobDetails.id}`, selectedJobDetails.content || '');
      toast({
        title: 'Context saved',
        description: 'This job briefing is now saved locally for future sessions.',
      });
    } catch (error) {
      console.error('Failed to save context', error);
      toast({
        variant: 'destructive',
        title: 'Save failed',
        description: 'Could not save the evaluation context locally.',
      });
    }
  }

  function updateResumeResult(index: number, patch: Partial<ResumeResult>) {
    setResumeResults((previous) => {
      const next = [...previous];
      if (next[index]) {
        next[index] = { ...next[index], ...patch };
      }
      return next;
    });
  }

  function updateCandidateMeta(applicationId: number, patch: Partial<CandidateMeta[number]>) {
    setCandidateMeta((previous) => ({
      ...previous,
      [applicationId]: {
        bucket: previous[applicationId]?.bucket || 'none',
        notes: previous[applicationId]?.notes || '',
        ...patch,
      },
    }));
  }

  async function handleSaveGreenhouseNote(result: ResumeResult, notes: string) {
    if (!notes.trim()) {
      toast({
        variant: 'destructive',
        title: 'Add note content',
        description: 'Write a recruiter note before saving it to Greenhouse.',
      });
      return;
    }

    if (!selectedNoteAuthorId) {
      toast({
        variant: 'destructive',
        title: 'Choose a Greenhouse user',
        description: 'Select who should be listed as the author before saving the note.',
      });
      return;
    }

    let candidateId = result.candidateId;

    if (!candidateId && result.applicationId) {
      const lookup = await getApplicationCandidateId(greenhouseApiKey, result.applicationId);
      setRateLimit(lookup.rateLimit ?? rateLimit);

      if (lookup.success && lookup.candidateId) {
        candidateId = lookup.candidateId;
        const index = resumeResults.findIndex((item) => item.applicationId === result.applicationId);
        if (index >= 0) {
          updateResumeResult(index, { candidateId: lookup.candidateId });
        }
      }
    }

    if (!candidateId) {
      toast({
        variant: 'destructive',
        title: 'Candidate unavailable',
        description: `No Greenhouse candidate id was found for application ${result.applicationId ?? 'unknown'}.`,
      });
      return;
    }

    const taggedUserId = result.applicationId ? taggedUserByApplication[result.applicationId] : 'none';
    const taggedUser = taggedUserId && taggedUserId !== 'none' ? greenhouseUsers.find((user) => String(user.id) === taggedUserId) : undefined;
    const noteBody = taggedUser ? `@${getGreenhouseUserLabel(taggedUser)} ${notes}` : notes;

    const response = await addCandidateNote(
      greenhouseApiKey,
      candidateId,
      Number(selectedNoteAuthorId),
      noteBody,
    );

    setRateLimit(response.rateLimit ?? rateLimit);

    if (!response.success) {
      toast({
        variant: 'destructive',
        title: 'Greenhouse note failed',
        description: response.error || 'Unable to save the note to Greenhouse.',
      });
      return;
    }

    if (notifyTaggedTeammate && serverConfig.outreachConfigured && taggedUser?.primary_email_address) {
      const author = greenhouseUsers.find((user) => String(user.id) === selectedNoteAuthorId);
      const authorLabel = author ? getGreenhouseUserLabel(author) : 'A teammate';
      const emailResponse = await sendOutreachEmails([
        {
          to: taggedUser.primary_email_address,
          subject: `${authorLabel} tagged you on ${result.candidateName}`,
          message: `${authorLabel} tagged you in a candidate note.\n\nCandidate: ${result.candidateName}\nRole stage: ${result.stageName || 'Unknown stage'}\nSource: ${result.sourceName || 'Unknown source'}\n\nNote:\n${noteBody}\n\nOpen the candidate in Greenhouse or the screening app to review next steps.`,
          candidateName: result.candidateName || 'Candidate',
        },
      ]);

      if (!emailResponse.success) {
        toast({
          variant: 'destructive',
          title: 'Note saved, email not sent',
          description: emailResponse.error || 'The Greenhouse note was saved, but teammate notification email failed.',
        });
        return;
      }
    }

    toast({
      title: 'Note saved to Greenhouse',
      description:
        taggedUser && notifyTaggedTeammate && serverConfig.outreachConfigured && taggedUser.primary_email_address
          ? `Saved note and emailed ${getGreenhouseUserLabel(taggedUser)}.`
          : taggedUser
            ? `Saved note and tagged ${getGreenhouseUserLabel(taggedUser)}.`
            : 'Saved note to the candidate in Greenhouse.',
    });
  }

  async function evaluateOneResume(result: ResumeResult) {
    const aiContext = selectedJobDetails?.content || '';
    const liveJobDescription = liveJobPostContent || '';

    return evaluateResumeWithOpenAI(
      trimmedOpenAIApiKey,
      result.url || '',
      result.fileName,
      aiContext || liveJobDescription,
      liveJobDescription
    );
  }

  async function runEvaluationQueue(initialResults: ResumeResult[]) {
    const runId = ++evaluationRunIdRef.current;
    stopEvaluationRef.current = false;
    const queue = initialResults
      .map((result, index) => ({ result, index }))
      .filter(({ result }) => result.success && result.url && result.status === 'pending');

    if (queue.length === 0) {
      setIsFetchingResumes(false);
      setProcessCompleted(true);
      setStatus('Nothing to evaluate.');
      return;
    }

    if (!isOpenAIReady) {
      queue.forEach(({ index }) => updateResumeResult(index, { status: 'error', error: 'Evaluation skipped because no OpenAI key is configured.' }));
      setIsFetchingResumes(false);
      setProcessCompleted(true);
      setStatus('OpenAI not configured.');
      return;
    }

    if (!(selectedJobDetails?.content || liveJobPostContent)) {
      queue.forEach(({ index }) => updateResumeResult(index, { status: 'error', error: 'Evaluation skipped because job context is missing.' }));
      setIsFetchingResumes(false);
      setProcessCompleted(true);
      setStatus('Job context missing.');
      return;
    }

    setStatus(`Evaluating ${queue.length} resumes with AI...`);
    setProgress(8);

    let completed = 0;
    const concurrency = Math.min(3, queue.length);
    let pointer = 0;

    const worker = async () => {
      while (pointer < queue.length) {
        if (stopEvaluationRef.current || evaluationRunIdRef.current !== runId) {
          return;
        }

        const current = queue[pointer];
        pointer += 1;

        updateResumeResult(current.index, { status: 'processing', error: undefined });

        try {
          const evaluation = await evaluateOneResume(current.result);
          if (stopEvaluationRef.current || evaluationRunIdRef.current !== runId) {
            return;
          }
          if (!evaluation.success || !evaluation.evaluation) {
            throw new Error(evaluation.error || 'Unknown evaluation error');
          }

          updateResumeResult(current.index, {
            status: 'success',
            success: true,
            score: evaluation.evaluation.score,
            evaluationSummary: evaluation.evaluation.evaluationSummary,
            fullEvaluation: evaluation.evaluation.fullEvaluation,
            recommendation: evaluation.evaluation.recommendation,
            scoreBreakdown: evaluation.evaluation.scoreBreakdown,
            strengths: evaluation.evaluation.strengths,
            concerns: evaluation.evaluation.concerns,
            authenticityRisk: evaluation.evaluation.authenticityRisk,
            authenticitySignals: evaluation.evaluation.authenticitySignals,
            interviewQuestions: evaluation.evaluation.interviewQuestions,
            nextStepSuggestion: evaluation.evaluation.nextStepSuggestion,
            linkedinUrl: evaluation.evaluation.linkedinUrl,
            linkedinDetected: evaluation.evaluation.linkedinDetected,
            githubUrl: evaluation.evaluation.githubUrl,
            githubDetected: evaluation.evaluation.githubDetected,
          });
        } catch (error) {
          updateResumeResult(current.index, {
            status: 'error',
            success: false,
            error: error instanceof Error ? error.message : 'Evaluation failed.',
          });
        } finally {
          if (stopEvaluationRef.current || evaluationRunIdRef.current !== runId) {
            return;
          }
          completed += 1;
          setProgress(8 + (completed / queue.length) * 92);
          setStatus(`Evaluated ${completed} of ${queue.length} resumes...`);
        }
      }
    };

    await Promise.all(Array.from({ length: concurrency }, () => worker()));

    if (stopEvaluationRef.current || evaluationRunIdRef.current !== runId) {
      return;
    }

    setProcessCompleted(true);
    setIsFetchingResumes(false);
    setProgress(100);
    setStatus('All evaluations complete.');
  }

  async function handleFetchResumes() {
    if (!selectedJobId) {
      toast({
        variant: 'destructive',
        title: 'Select a job first',
        description: 'Choose a job before fetching candidates.',
      });
      return;
    }

    setIsFetchingResumes(true);
    setProcessCompleted(false);
    setResumeResults([]);
    setAiSearchSummary('');
    setAiSearchMatches([]);
    setShowOnlyAiMatches(false);
    setSelectedCandidates(new Set());
    setSingleEvalResult(null);
    setProgress(0);
    setStatus('Fetching applications from Greenhouse...');

    const result = await getResumesForJob(Number(selectedJobId), greenhouseApiKey, applicationStatusFilter);
    setRateLimit(result.rateLimit ?? null);

    if (!result.success || !result.resumeResults) {
      setIsFetchingResumes(false);
      setStatus(result.error || 'Failed to fetch applications.');
      toast({
        variant: 'destructive',
        title: 'Fetch failed',
        description: result.error || 'Could not load applications.',
      });
      return;
    }

    const initialResults = result.resumeResults.map((item) => ({
      ...item,
      status: item.success ? ('pending' as const) : ('error' as const),
      error: item.success ? undefined : item.error,
    }));

    setResumeResults(initialResults);
    toast({
      title: 'Candidates loaded',
      description: result.message || `Fetched ${initialResults.length} applications.`,
    });

    await runEvaluationQueue(initialResults);
  }

  async function handleRetryEvaluation(index: number) {
    const result = resumeResults[index];
    if (!result?.url) {
      return;
    }

    updateResumeResult(index, { status: 'processing', error: undefined });
    try {
      const evaluation = await evaluateOneResume(result);
      if (!evaluation.success || !evaluation.evaluation) {
        throw new Error(evaluation.error || 'Retry failed.');
      }

      updateResumeResult(index, {
        status: 'success',
        success: true,
        score: evaluation.evaluation.score,
        evaluationSummary: evaluation.evaluation.evaluationSummary,
        fullEvaluation: evaluation.evaluation.fullEvaluation,
        recommendation: evaluation.evaluation.recommendation,
        scoreBreakdown: evaluation.evaluation.scoreBreakdown,
        strengths: evaluation.evaluation.strengths,
        concerns: evaluation.evaluation.concerns,
        authenticityRisk: evaluation.evaluation.authenticityRisk,
        authenticitySignals: evaluation.evaluation.authenticitySignals,
        interviewQuestions: evaluation.evaluation.interviewQuestions,
        nextStepSuggestion: evaluation.evaluation.nextStepSuggestion,
        linkedinUrl: evaluation.evaluation.linkedinUrl,
        linkedinDetected: evaluation.evaluation.linkedinDetected,
        githubUrl: evaluation.evaluation.githubUrl,
        githubDetected: evaluation.evaluation.githubDetected,
      });
    } catch (error) {
      updateResumeResult(index, {
        status: 'error',
        success: false,
        error: error instanceof Error ? error.message : 'Retry failed.',
      });
    }
  }

  async function handleEvaluateSingleResume() {
    if (!singleResumeFile) {
      toast({
        variant: 'destructive',
        title: 'Choose a file first',
        description: 'Upload a resume before running an evaluation.',
      });
      return;
    }

    if (!isOpenAIReady) {
      toast({
        variant: 'destructive',
        title: 'OpenAI not configured',
        description: 'Configure an OpenAI API key on the server or for this session.',
      });
      return;
    }

    if (!(selectedJobDetails?.content || liveJobPostContent)) {
      toast({
        variant: 'destructive',
        title: 'Missing context',
        description: 'Add or load a job brief before evaluating a single resume.',
      });
      return;
    }

    setIsEvaluatingSingle(true);
    setSingleEvalResult(null);

    const formData = new FormData();
    formData.append('file', singleResumeFile);
    formData.append('openAIApiKey', trimmedOpenAIApiKey);
    formData.append('aiContext', selectedJobDetails?.content || '');
    formData.append('liveJobDescription', liveJobPostContent || '');

    const result = await evaluateSingleResume(formData);

    if (!result.success || !result.evaluation) {
      setSingleEvalResult({
        success: false,
        fileName: singleResumeFile.name,
        candidateName: singleResumeFile.name.replace(/\.[^.]+$/, ''),
        status: 'error',
        error: result.error || 'Evaluation failed.',
      });
      setIsEvaluatingSingle(false);
      return;
    }

    setSingleEvalResult({
      success: true,
      fileName: singleResumeFile.name,
      candidateName: singleResumeFile.name.replace(/\.[^.]+$/, ''),
      status: 'success',
      score: result.evaluation.score,
      evaluationSummary: result.evaluation.evaluationSummary,
      fullEvaluation: result.evaluation.fullEvaluation,
      recommendation: result.evaluation.recommendation,
      scoreBreakdown: result.evaluation.scoreBreakdown,
      strengths: result.evaluation.strengths,
      concerns: result.evaluation.concerns,
      authenticityRisk: result.evaluation.authenticityRisk,
      authenticitySignals: result.evaluation.authenticitySignals,
      interviewQuestions: result.evaluation.interviewQuestions,
      nextStepSuggestion: result.evaluation.nextStepSuggestion,
      linkedinUrl: result.evaluation.linkedinUrl,
      linkedinDetected: result.evaluation.linkedinDetected,
      githubUrl: result.evaluation.githubUrl,
      githubDetected: result.evaluation.githubDetected,
    });
    setIsEvaluatingSingle(false);
  }

  async function handleRunAiSearch() {
    if (!aiSearchQuery.trim()) {
      toast({
        variant: 'destructive',
        title: 'Add a search prompt',
        description: 'Describe what kind of candidates you want ChatGPT to find.',
      });
      return;
    }

    const keywordTerms = parseKeywordSearchTerms(aiSearchQuery);
    if (keywordTerms.length > 0) {
      const keywordMatches = enrichedResults
        .filter((result): result is typeof result & { applicationId: number } => Boolean(result.applicationId))
        .map((result) => {
          const searchableSections = [
            { label: 'summary', value: result.evaluationSummary || '' },
            { label: 'detailed review', value: stripHtmlTags(result.fullEvaluation) },
            { label: 'strengths', value: (result.strengths || []).join(' ') },
            { label: 'concerns', value: (result.concerns || []).join(' ') },
            { label: 'next step', value: result.nextStepSuggestion || '' },
            { label: 'candidate', value: result.candidateName || '' },
            { label: 'source', value: result.sourceName || '' },
            { label: 'stage', value: result.stageName || '' },
          ];

          const matchedTerms = keywordTerms.filter((term) => {
            const lowerTerm = term.toLowerCase();
            return searchableSections.some((section) => section.value.toLowerCase().includes(lowerTerm));
          });

          if (matchedTerms.length === 0) {
            return null;
          }

          const matchedSections = searchableSections
            .filter((section) =>
              matchedTerms.some((term) => section.value.toLowerCase().includes(term.toLowerCase()))
            )
            .map((section) => section.label);

          return {
            applicationId: result.applicationId,
            candidateName: result.candidateName || `Application ${result.applicationId}`,
            rationale: `Matched keyword${matchedTerms.length === 1 ? '' : 's'}: ${matchedTerms.join(', ')}${matchedSections.length ? ` in ${Array.from(new Set(matchedSections)).join(', ')}` : ''}.`,
          };
        })
        .filter((match): match is CandidateSearchMatch => Boolean(match));

      setAiSearchSummary(
        keywordMatches.length > 0
          ? `Keyword search found ${keywordMatches.length} candidate match${keywordMatches.length === 1 ? '' : 'es'} for: ${keywordTerms.join(', ')}.`
          : `No candidates matched these keywords in the screened resume analysis: ${keywordTerms.join(', ')}.`
      );
      setAiSearchMatches(keywordMatches);
      setShowOnlyAiMatches(keywordMatches.length > 0);

      if (keywordMatches.length > 0) {
        setSelectedCandidates(new Set(keywordMatches.map((match) => match.applicationId)));
      }

      toast({
        title: 'Keyword search completed',
        description: keywordMatches.length > 0
          ? `Found ${keywordMatches.length} keyword match${keywordMatches.length === 1 ? '' : 'es'}.`
          : 'No keyword matches found.',
      });
      return;
    }

    const searchableCandidates = enrichedResults
      .filter((result): result is typeof result & { applicationId: number } => Boolean(result.applicationId) && result.status === 'success')
      .map((result) => ({
        applicationId: result.applicationId,
        candidateName: result.candidateName || `Application ${result.applicationId}`,
        stageName: result.stageName,
        sourceName: result.sourceName,
        score: result.score ?? null,
        recommendation: result.recommendation ?? null,
        evaluationSummary: result.evaluationSummary,
        strengths: result.strengths,
        concerns: result.concerns,
        authenticityRisk: result.authenticityRisk,
        authenticitySignals: result.authenticitySignals,
      }));

    if (searchableCandidates.length === 0) {
      toast({
        variant: 'destructive',
        title: 'No screened candidates yet',
        description: 'Run screening first so AI search has candidate summaries to work with.',
      });
      return;
    }

    setIsRunningAiSearch(true);

    try {
      const result = await runCandidateSearchCopilot(
        trimmedOpenAIApiKey,
        aiSearchQuery,
        searchableCandidates,
        selectedJobDetails?.content,
        liveJobPostContent || undefined,
      );

      if (!result.success) {
        toast({
          variant: 'destructive',
          title: 'AI search failed',
          description: result.error || 'Unable to run AI search right now.',
        });
        return;
      }

      setAiSearchSummary(result.summary || '');
      setAiSearchMatches(result.matches || []);
      setShowOnlyAiMatches((result.matches || []).length > 0);

      if (result.matches && result.matches.length > 0) {
        setSelectedCandidates(new Set(result.matches.map((match) => match.applicationId)));
      }

      toast({
        title: 'AI search completed',
        description: result.matches?.length
          ? `Found ${result.matches.length} candidate match${result.matches.length === 1 ? '' : 'es'}.`
          : 'No strong matches found for that prompt.',
      });
    } finally {
      setIsRunningAiSearch(false);
    }
  }

  function handleSelectCandidate(applicationId: number, checked: boolean) {
    setSelectedCandidates((previous) => {
      const next = new Set(previous);
      if (checked) {
        next.add(applicationId);
      } else {
        next.delete(applicationId);
      }
      return next;
    });
  }

  async function handleValidateOpenAIKey() {
    setIsValidatingOpenAIKey(true);
    const result = await validateOpenAIApiKey(trimmedOpenAIApiKey);
    setIsValidatingOpenAIKey(false);

    if (result.success) {
      toast({
        title: 'OpenAI key validated',
        description: 'Authentication to the OpenAI API succeeded.',
      });
      return;
    }

    toast({
      variant: 'destructive',
      title: 'OpenAI validation failed',
      description: result.error || 'The key could not be validated.',
    });
  }

  async function handleCopyOutreach(result: ResumeResult) {
    const subject = buildOutreachSubject(result);
    const body = buildOutreachMessage(result);

    try {
      await navigator.clipboard.writeText(`Subject: ${subject}\n\n${body}`);
      toast({
        title: 'Email draft copied',
        description: `Personalized outreach for ${result.candidateName || 'candidate'} is on your clipboard.`,
      });
    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Copy failed',
        description: 'Clipboard access was not available.',
      });
    }
  }

  function handleOpenMailDraft(result: ResumeResult) {
    if (!result.candidateEmail) {
      toast({
        variant: 'destructive',
        title: 'No email found',
        description: `We could not find an email address for ${result.candidateName || 'this candidate'} in the Greenhouse payload.`,
      });
      return;
    }

    const subject = encodeURIComponent(buildOutreachSubject(result));
    const body = encodeURIComponent(buildOutreachMessage(result));
    window.open(`mailto:${result.candidateEmail}?subject=${subject}&body=${body}`, '_blank');
  }

  function handleSelectAll(checked: boolean) {
    if (!checked) {
      setSelectedCandidates(new Set());
      return;
    }

    setSelectedCandidates(new Set(filteredResults.map((result) => result.applicationId).filter(Boolean) as number[]));
  }

  function applyBucketToSelected(bucket: CandidateBucket) {
    const ids = Array.from(selectedCandidates);
    ids.forEach((id) => updateCandidateMeta(id, { bucket }));
    toast({
      title: 'Shortlist updated',
      description: `Moved ${ids.length} candidate${ids.length === 1 ? '' : 's'} to ${bucketCopy[bucket]}.`,
    });
  }

  async function handleSendRejections() {
    if (selectedCandidates.size === 0 || !selectedRejectionReason) {
      toast({
        variant: 'destructive',
        title: 'Missing information',
        description: 'Select candidates and a rejection reason first.',
      });
      return;
    }

    const confirmed = window.confirm(`Send rejection emails to ${selectedCandidates.size} selected candidate(s)? This cannot be undone.`);
    if (!confirmed) {
      return;
    }

    setIsSendingRejections(true);

    let successCount = 0;
    let failureCount = 0;
    const templateId = selectedEmailTemplate === '-1' ? null : Number(selectedEmailTemplate);

    for (const applicationId of selectedCandidates) {
      const response = await rejectApplication(
        greenhouseApiKey,
        applicationId,
        Number(selectedRejectionReason),
        templateId
      );

      if (response.success) {
        successCount += 1;
        updateCandidateMeta(applicationId, { bucket: 'reject' });
      } else {
        failureCount += 1;
      }
    }

    setIsSendingRejections(false);
    setSelectedCandidates(new Set());
    toast({
      title: 'Rejection run complete',
      description: `Sent ${successCount} rejection${successCount === 1 ? '' : 's'} successfully. ${failureCount} failed.`,
    });
  }

  function handleExportCsv() {
    const rows = rankedResults.filter((result) => result.status === 'success');
    if (rows.length === 0) {
      toast({
        variant: 'destructive',
        title: 'Nothing to export',
        description: 'Run an evaluation before exporting recruiter output.',
      });
      return;
    }

    const headers = [
      'Candidate',
      'Score',
      'Recommendation',
      'Stage',
      'Source',
      'Bucket',
      'Summary',
      'Recruiter Notes',
    ];
    const body = rows.map((result) => [
      result.candidateName || 'Unknown',
      typeof result.score === 'number' ? result.score : '',
      result.recommendation ? recommendationCopy[result.recommendation] : '',
      result.stageName || '',
      result.sourceName || '',
      bucketCopy[result.bucket as CandidateBucket],
      `"${(result.evaluationSummary || '').replace(/"/g, '""')}"`,
      `"${(result.notes || '').replace(/"/g, '""')}"`,
    ].join(','));

    const blob = new Blob([[headers.join(','), ...body].join('\n')], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.href = url;
    link.download = `${(selectedJobDetails?.name || 'candidate-review').replace(/\s+/g, '_')}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  async function handleExportToPdf(candidateName: string, fullEvaluation: string, questions?: string[]) {
    const container = document.createElement('div');
    container.style.width = '900px';
    container.style.padding = '32px';
    container.style.background = '#ffffff';
    container.style.fontFamily = 'Manrope, sans-serif';
    container.innerHTML = `
      <h1 style="font-size: 28px; margin-bottom: 12px;">Candidate Review: ${candidateName}</h1>
      ${fullEvaluation}
      ${questions && questions.length > 0 ? `<h2 style="font-size: 20px; margin-top: 24px;">Interview Questions</h2><ul>${questions.map((question) => `<li>${question}</li>`).join('')}</ul>` : ''}
    `;
    document.body.appendChild(container);

    try {
      const canvas = await html2canvas(container, { scale: 2, useCORS: true, backgroundColor: '#ffffff' });
      const pdf = new jsPDF('p', 'mm', 'a4');
      const image = canvas.toDataURL('image/png');
      const props = pdf.getImageProperties(image);
      const width = pdf.internal.pageSize.getWidth();
      const height = (props.height * width) / props.width;
      let remaining = height;
      let position = 0;

      pdf.addImage(image, 'PNG', 0, position, width, height);
      remaining -= pdf.internal.pageSize.getHeight();

      while (remaining > 0) {
        position = remaining - height;
        pdf.addPage();
        pdf.addImage(image, 'PNG', 0, position, width, height);
        remaining -= pdf.internal.pageSize.getHeight();
      }

      pdf.save(`${candidateName.replace(/\s+/g, '_')}_review.pdf`);
    } catch (error) {
      console.error('Failed to export PDF', error);
      toast({
        variant: 'destructive',
        title: 'PDF export failed',
        description: 'Unable to generate the PDF review pack.',
      });
    } finally {
      document.body.removeChild(container);
    }
  }

  function clearLocalWorkspaceData() {
    try {
      Object.keys(localStorage).forEach((key) => {
        if (key.startsWith(LOCAL_CONTEXT_PREFIX) || key.startsWith(LOCAL_META_PREFIX) || key === LOCAL_OUTREACH_SETTINGS_KEY) {
          localStorage.removeItem(key);
        }
      });
    } catch (error) {
      console.error('Failed to clear local workspace data', error);
    }

    setSelectedJobDetails(null);
    setLiveJobPostContent(null);
    setResumeResults([]);
    setAiSearchQuery('');
    setAiSearchSummary('');
    setAiSearchMatches([]);
    setShowOnlyAiMatches(false);
    setCandidateMeta({});
    setSingleResumeFile(null);
    setSingleEvalResult(null);
    setSelectedCandidates(new Set());
    setProcessCompleted(false);
    setRecruiterName('Recruiting Team');
    setRecruiterTitle('Talent Acquisition');
    setCalendarLink('');
    setOutreachTemplate('Hi {{candidateFirstName}},\n\nWe enjoyed reviewing your background for the {{jobTitle}} role at Wasabi Technologies. Your experience stood out and we would love to connect for a short intro call.\n\nYou can pick a time that works for you here: {{calendarLink}}\n\n{{personalizedLine}}\n\nBest,\n{{recruiterName}}\n{{recruiterTitle}}\nWasabi Technologies');

    toast({
      title: 'Local workspace cleared',
      description: 'Saved job context and recruiter notes were removed from this browser.',
    });
  }

  async function handleSendOutreach(result: ResumeResult) {
    if (!result.candidateEmail) {
      toast({
        variant: 'destructive',
        title: 'No email found',
        description: `We could not find an email address for ${result.candidateName || 'this candidate'}.`,
      });
      return;
    }

    setIsSendingOutreach(true);
    const response = await sendOutreachEmails([
      {
        to: result.candidateEmail,
        subject: buildOutreachSubject(result),
        message: buildOutreachMessage(result),
        candidateName: result.candidateName || 'Candidate',
      },
    ]);
    setIsSendingOutreach(false);

    if (!response.success && !response.sentCount) {
      toast({
        variant: 'destructive',
        title: 'Email send failed',
        description: response.error || 'Could not send the outreach email.',
      });
      return;
    }

    toast({
      title: 'Outreach sent',
      description: `Email sent to ${result.candidateName || result.candidateEmail}.`,
    });
  }

  async function handleSendBulkOutreach() {
    const payloads = outreachCandidates
      .filter((candidate) => candidate.candidateEmail)
      .map((candidate) => ({
        to: candidate.candidateEmail!,
        subject: buildOutreachSubject(candidate),
        message: buildOutreachMessage(candidate),
        candidateName: candidate.candidateName || 'Candidate',
      }));

    if (payloads.length === 0) {
      toast({
        variant: 'destructive',
        title: 'No deliverable candidates',
        description: 'Select candidates with email addresses or move them into Top picks first.',
      });
      return;
    }

    setIsSendingOutreach(true);
    const response = await sendOutreachEmails(payloads);
    setIsSendingOutreach(false);

    if (!response.success && !response.sentCount) {
      toast({
        variant: 'destructive',
        title: 'Bulk outreach failed',
        description: response.error || 'Could not send outreach emails.',
      });
      return;
    }

    toast({
      title: 'Bulk outreach finished',
      description: `Sent ${response.sentCount || 0} email(s). ${response.failed?.length || 0} failed.`,
    });
  }

  return (
    <div className="w-full max-w-[1500px] space-y-7">
      <Card className="overflow-hidden border-white/8 bg-[rgba(8,12,28,0.86)] shadow-[0_40px_120px_-56px_rgba(0,0,0,0.9)] backdrop-blur-xl">
        <div className={`grid gap-0 ${isGreenhouseConnected ? '' : 'lg:grid-cols-[1.1fr_0.9fr]'}`}>
          <div
            className={`relative overflow-hidden bg-[linear-gradient(180deg,_rgba(15,24,53,0.9)_0%,_rgba(20,31,63,0.88)_50%,_rgba(23,35,65,0.84)_100%)] px-8 py-9 ${
              isGreenhouseConnected ? '' : 'border-b border-white/10 lg:border-b-0 lg:border-r lg:border-white/10'
            }`}
          >
            <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(180deg,_rgba(255,255,255,0.02),_rgba(255,255,255,0.01))]" />
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="relative z-10 space-y-5">
                <div className="inline-flex items-center gap-2 rounded-full border border-white/12 bg-white/8 px-3 py-1 text-xs font-semibold uppercase tracking-[0.22em] text-white/80">
                  <Sparkles className="h-3.5 w-3.5" />
                  Recruiter Copilot
                </div>
                <div className="flex flex-wrap items-center gap-5">
                  <div className="relative flex items-center justify-center rounded-full">
                    <div className="pointer-events-none absolute h-36 w-36 rounded-full bg-[radial-gradient(circle,_rgba(127,220,138,0.24),_rgba(127,220,138,0.05)_60%,_transparent_100%)] blur-2xl" />
                    <Image src="/wasabi-logo.jpeg" alt="Wasabi Technologies logo" width={228} height={92} className="relative h-[5rem] w-auto max-w-[14rem] object-contain mix-blend-screen" />
                  </div>
                  <div className="space-y-2">
                    <p className="text-base font-semibold uppercase tracking-[0.32em] text-[#7fdc8a]">Wasabi Technologies</p>
                      <h1 className="text-4xl font-semibold tracking-tight text-white sm:text-5xl">RRE</h1>
                      <p className="max-w-2xl text-base leading-7 text-white">
                        Pull candidates from Greenhouse, rank them with AI, annotate recruiter notes, compare finalists, and move faster with cleaner Wasabi-branded outreach.
                      </p>
                    </div>
                  </div>
              </div>
              <div className="relative z-10 flex flex-wrap items-center gap-2">
                {isGreenhouseConnected && !showAccessSetup && (
                  <Button variant="ghost" onClick={() => setShowAccessSetup(true)} className="border border-white/10 bg-white/8 text-white hover:bg-white/14">
                    <RefreshCw className="mr-2 h-4 w-4" />
                    Reconnect
                  </Button>
                )}
                <Button variant="ghost" onClick={clearLocalWorkspaceData} className="border border-white/10 bg-white/8 text-white hover:bg-white/14">
                  <XCircle className="mr-2 h-4 w-4" />
                  Clear Local Data
                </Button>
              </div>
            </div>

            <div className="relative z-10 mt-9 grid gap-4 sm:grid-cols-3">
              <SummaryMetric label="Candidates" value={String(metrics.total)} hint="Loaded into the current review workspace." tone="dark" />
              <SummaryMetric label="Avg Score" value={metrics.averageScore} hint="Average AI score across evaluated resumes." tone="dark" />
              <SummaryMetric label="Interview Ready" value={String(metrics.interviewReady)} hint="Candidates recommended for interview." tone="dark" />
            </div>
          </div>

          {(!isGreenhouseConnected || showAccessSetup) && (
            <div className="relative overflow-hidden bg-[linear-gradient(180deg,_rgba(255,255,255,0.16),_rgba(255,255,255,0.06))] p-6 sm:p-8">
              <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,_rgba(255,255,255,0.18),_transparent_34%)]" />
              <div className="pointer-events-none absolute -right-8 top-10 h-40 w-40 rounded-full bg-[radial-gradient(circle,_rgba(66,199,74,0.18),_transparent_70%)] blur-2xl" />
              <div className="pointer-events-none absolute -left-12 bottom-0 h-44 w-44 rounded-full bg-[radial-gradient(circle,_rgba(112,173,255,0.2),_transparent_70%)] blur-3xl" />

              <div className="relative mx-auto max-w-[560px] rounded-[2rem] border border-white/35 bg-[linear-gradient(180deg,_rgba(255,255,255,0.82),_rgba(246,250,252,0.72))] p-6 shadow-[0_28px_80px_-42px_rgba(8,12,28,0.72)] backdrop-blur-xl sm:p-8">
                <div className="space-y-6">
                  <div className="space-y-4 text-center">
                    <div className="inline-flex items-center gap-2 rounded-full border border-white/70 bg-white/65 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.24em] text-slate-500 shadow-sm">
                      <Sparkles className="h-3.5 w-3.5 text-[#177a2a]" />
                      Secure Access
                    </div>
                    <div className="space-y-2">
                      <h2 className="text-3xl font-semibold tracking-tight text-slate-950">Welcome Back</h2>
                      <p className="mx-auto max-w-md text-sm leading-6 text-slate-600">
                        Connect your Greenhouse and OpenAI session to start screening candidates in the Wasabi cloud recruiting workspace.
                      </p>
                    </div>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="rounded-2xl border border-white/60 bg-white/72 px-4 py-4 shadow-sm backdrop-blur">
                      <div className="flex items-center gap-3">
                        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white shadow-sm ring-1 ring-slate-100">
                          <Image src="/greenhouse-logo.png" alt="Greenhouse logo" width={88} height={20} className="h-auto w-8 object-contain" />
                        </div>
                        <div>
                          <p className="text-sm font-semibold text-slate-900">Greenhouse</p>
                          <p className="text-xs text-slate-500">ATS connection</p>
                        </div>
                      </div>
                      <p className="mt-3 text-sm leading-6 text-slate-600">
                        {serverConfig.greenhouseConfigured ? 'Configured on the server. You can override it for this session below.' : 'Not configured on the server.'}
                      </p>
                    </div>
                    <div className="rounded-2xl border border-white/60 bg-white/72 px-4 py-4 shadow-sm backdrop-blur">
                      <div className="flex items-center gap-3">
                        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white shadow-sm ring-1 ring-slate-100">
                          <Image src="/openai-logo.svg" alt="OpenAI logo" width={28} height={28} className="h-7 w-7 object-contain" />
                        </div>
                        <div>
                          <p className="text-sm font-semibold text-slate-900">OpenAI</p>
                          <p className="text-xs text-slate-500">AI scoring engine</p>
                        </div>
                      </div>
                      <p className="mt-3 text-sm leading-6 text-slate-600">
                        {serverConfig.openAIConfigured ? 'Configured on the server for secure evaluations.' : 'Optional session-only override available below.'}
                      </p>
                    </div>
                  </div>

                  <div className="rounded-[1.6rem] border border-white/70 bg-white/80 p-5 shadow-[0_18px_36px_-28px_rgba(15,23,42,0.34)] backdrop-blur">
                    <div className="space-y-4">
                      <div className="space-y-2">
                        <Label htmlFor="greenhouse-key" className="text-slate-700">Greenhouse Session Key</Label>
                        <div className="relative">
                          <KeyRound className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                          <Input
                            id="greenhouse-key"
                            type="password"
                            value={greenhouseApiKey}
                            onChange={(event) => setGreenhouseApiKey(event.target.value)}
                            placeholder="Optional override for this session"
                            className="h-12 rounded-xl border-slate-200 bg-white/95 pl-10 text-slate-900 placeholder:text-slate-400"
                          />
                        </div>
                      </div>

                      <div className="space-y-2">
                        <Label htmlFor="openai-key" className="text-slate-700">OpenAI Session Key</Label>
                        <div className="relative">
                          <KeyRound className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                          <Input
                            id="openai-key"
                            type="password"
                            value={openAIApiKey}
                            onChange={(event) => setOpenAIApiKey(event.target.value)}
                            placeholder="Optional override for this session"
                            className="h-12 rounded-xl border-slate-200 bg-white/95 pl-10 text-slate-900 placeholder:text-slate-400"
                          />
                        </div>
                        <p className="text-xs leading-5 text-slate-500">Session keys are kept in memory only and are not written to local storage.</p>
                      </div>

                      <div className="grid gap-3 sm:grid-cols-[0.95fr_1.05fr]">
                        <Button type="button" variant="outline" onClick={handleValidateOpenAIKey} disabled={isValidatingOpenAIKey || !trimmedOpenAIApiKey} className="h-12 rounded-xl border-slate-200 bg-white text-slate-900 hover:bg-slate-50">
                          {isValidatingOpenAIKey ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : <Bot className="mr-2 h-4 w-4" />}
                          Validate OpenAI Key
                        </Button>
                        <Button onClick={() => handleConnect(greenhouseApiKey)} disabled={isLoading} className="h-12 rounded-xl bg-[linear-gradient(90deg,_#4d7bff,_#6a8fff)] text-white shadow-[0_20px_34px_-22px_rgba(77,123,255,0.85)] hover:opacity-95">
                          {isLoading ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : <Inbox className="mr-2 h-4 w-4" />}
                          Connect And Load Jobs
                        </Button>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
        <CardFooter className="flex-col items-start gap-3 border-t border-white/10 bg-[linear-gradient(180deg,_rgba(13,18,38,0.92),_rgba(12,15,31,0.88))] px-8 py-5">
          {(isFetchingResumes || isLoading) && (
            <div className="w-full space-y-2">
              <Label className="text-white/78">{status}</Label>
              <Progress value={progress} className="w-full" />
            </div>
          )}
          <RateLimitDisplay rateLimit={rateLimit} tone="dark" />
        </CardFooter>
      </Card>

      {isGreenhouseConnected && (
        <div className="grid gap-6 xl:grid-cols-[420px_minmax(0,1fr)]">
          <Card className="sticky top-6 self-start overflow-hidden border-slate-200/90 bg-[rgba(255,255,255,0.97)] shadow-[0_22px_50px_-38px_rgba(15,23,42,0.32)]">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-2xl">
                <Briefcase className="h-5 w-5 text-teal-600" />
                Job Setup
              </CardTitle>
              <CardDescription>Select a job, refine the AI brief, and decide how to ingest resumes.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="space-y-2">
                <Label htmlFor="job-select">Open Job</Label>
                <Select value={selectedJobId} onValueChange={handleJobSelection}>
                  <SelectTrigger id="job-select">
                    <SelectValue placeholder="Choose a job posting..." />
                  </SelectTrigger>
                  <SelectContent>
                    {jobs.map((job) => (
                      <SelectItem key={job.id} value={String(job.id)}>
                        {job.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-4">
                <Card className="overflow-hidden border-slate-200/90 bg-[linear-gradient(180deg,_rgba(255,255,255,1),_rgba(248,250,252,0.96))] shadow-none">
                  <CardHeader className="pb-3">
                    <CardTitle className="text-base">Live Job Description</CardTitle>
                    <CardDescription>Current posting content from Greenhouse.</CardDescription>
                  </CardHeader>
                  <CardContent>
                    {isFetchingJobDetails && !liveJobPostContent ? (
                      <div className="flex h-44 items-center justify-center text-sm text-muted-foreground">
                        <LoaderCircle className="mr-2 h-4 w-4 animate-spin" />
                        Loading job post...
                      </div>
                    ) : (
                      <ScrollArea className="h-44 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
                        <pre className="whitespace-pre-wrap font-sans">{liveJobPostContent || 'No live job post found.'}</pre>
                      </ScrollArea>
                    )}
                  </CardContent>
                </Card>

                <Card className="overflow-hidden border-slate-200/90 bg-[linear-gradient(180deg,_rgba(255,255,255,1),_rgba(248,250,252,0.96))] shadow-none">
                  <CardHeader className="pb-3">
                    <CardTitle className="text-base">AI Evaluation Brief</CardTitle>
                    <CardDescription>Adjust the hiring rubric before bulk screening.</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <Textarea
                      value={selectedJobDetails?.content || ''}
                      onChange={(event) => setSelectedJobDetails((current) => current ? { ...current, content: event.target.value } : current)}
                      placeholder="Customize the hiring rubric, must-have experience, and evaluation instructions."
                      className="min-h-44"
                    />
                    <Button onClick={saveJobContext} size="sm" variant="outline" disabled={!selectedJobDetails}>
                      <Save className="mr-2 h-4 w-4" />
                      Save Job Brief
                    </Button>
                  </CardContent>
                </Card>
              </div>

              <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-1">
                <Card className="overflow-hidden border-slate-200/90 bg-[linear-gradient(180deg,_rgba(255,255,255,1),_rgba(247,252,248,0.96))] shadow-none">
                  <CardHeader className="pb-3">
                    <CardTitle className="text-base">Bulk Screening</CardTitle>
                    <CardDescription>Fetch candidates from Greenhouse and run AI ranking.</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="space-y-2">
                      <Label htmlFor="status-filter-select">Application Status</Label>
                      <Select value={applicationStatusFilter} onValueChange={setApplicationStatusFilter}>
                        <SelectTrigger id="status-filter-select">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">All applications</SelectItem>
                          <SelectItem value="active">Active</SelectItem>
                          <SelectItem value="hired">Hired</SelectItem>
                          <SelectItem value="rejected">Rejected</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </CardContent>
                  <CardFooter>
                    <div className="grid w-full gap-2">
                      <Button onClick={handleFetchResumes} disabled={!selectedJobId || isFetchingResumes || isEvaluatingSingle} className="w-full bg-teal-600 text-white hover:bg-teal-700">
                        {isFetchingResumes ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : <Download className="mr-2 h-4 w-4" />}
                        Fetch And Evaluate
                      </Button>
                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                        <Button type="button" variant="outline" onClick={handleResetReview} disabled={isEvaluatingSingle}>
                          <RefreshCw className="mr-2 h-4 w-4" />
                          Reset Review
                        </Button>
                        <Button type="button" variant="outline" onClick={isFetchingResumes ? handleStopScreening : handleStartNewJob} disabled={isEvaluatingSingle}>
                          {isFetchingResumes ? <XCircle className="mr-2 h-4 w-4" /> : <Briefcase className="mr-2 h-4 w-4" />}
                          {isFetchingResumes ? 'Stop Screening' : 'Start New Job'}
                        </Button>
                      </div>
                    </div>
                  </CardFooter>
                </Card>

                <Card className="overflow-hidden border-slate-200/90 bg-[linear-gradient(180deg,_rgba(255,255,255,1),_rgba(248,250,252,0.96))] shadow-none">
                  <CardHeader className="pb-3">
                    <CardTitle className="text-base">Single Resume Sandbox</CardTitle>
                    <CardDescription>Test a resume against the current rubric before bulk screening.</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <Input
                      ref={fileInputRef}
                      type="file"
                      accept=".pdf,.doc,.docx,.txt"
                      onChange={(event) => setSingleResumeFile(event.target.files?.[0] || null)}
                    />
                  </CardContent>
                  <CardFooter>
                    <Button onClick={handleEvaluateSingleResume} disabled={!singleResumeFile || isEvaluatingSingle} className="w-full">
                      {isEvaluatingSingle ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}
                      Evaluate Uploaded Resume
                    </Button>
                  </CardFooter>
                </Card>
              </div>
            </CardContent>
          </Card>

          <Card className="border-slate-200/90 bg-[rgba(255,255,255,0.97)] shadow-[0_24px_56px_-42px_rgba(15,23,42,0.32)]">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-2xl">
                <BarChart3 className="h-5 w-5 text-slate-800" />
                Screening Dashboard
              </CardTitle>
              <CardDescription>Prioritize finalists, document recruiter judgment, and prepare follow-up actions.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                <SummaryMetric label="Evaluated" value={String(metrics.scored)} hint="Resumes with AI output available." />
                <SummaryMetric label="Top Bucket" value={String(metrics.topBucket)} hint="Candidates manually marked as top picks." />
                <SummaryMetric label="Shortlist" value={String(selectedCandidates.size)} hint="Currently selected for bulk action." />
                <SummaryMetric label="Status" value={processCompleted ? 'Ready' : 'Live'} hint={status} />
              </div>

              {topCandidates.length > 0 && (
                <div className="grid gap-4 lg:grid-cols-3">
                  {topCandidates.map((candidate, index) => (
                    <Card key={candidate.applicationId} className="border-slate-200 bg-[linear-gradient(180deg,_rgba(255,255,255,1),_rgba(248,250,252,0.9))] shadow-none">
                      <CardHeader>
                        <CardDescription>Top candidate #{index + 1}</CardDescription>
                        <CardTitle className="text-xl">{candidate.candidateName}</CardTitle>
                      </CardHeader>
                      <CardContent className="space-y-4">
                        <div className={`inline-flex rounded-full px-4 py-2 text-sm font-semibold ${getScoreTone(candidate.score)}`}>
                          {candidate.score}/10
                        </div>
                        <p className="text-sm text-slate-600">{candidate.evaluationSummary}</p>
                        {candidate.recommendation && (
                          <Badge className={getRecommendationTone(candidate.recommendation)}>
                            {recommendationCopy[candidate.recommendation]}
                          </Badge>
                        )}
                      </CardContent>
                    </Card>
                  ))}
                </div>
              )}

              {singleEvalResult && (
                <Card className="border-sky-200 bg-sky-50/60 shadow-none">
                  <CardHeader>
                    <CardTitle className="text-lg">Single Resume Result</CardTitle>
                  </CardHeader>
                  <CardContent>
                    {singleEvalResult.status === 'success' ? (
                      <div className="flex flex-wrap items-center justify-between gap-4">
                        <div>
                          <p className="text-lg font-semibold text-slate-900">{singleEvalResult.candidateName}</p>
                          <p className="mt-1 text-sm text-slate-600">{singleEvalResult.evaluationSummary}</p>
                        </div>
                        <div className="flex items-center gap-3">
                          <div className={`rounded-full px-4 py-2 text-sm font-semibold ${getScoreTone(singleEvalResult.score)}`}>
                            {singleEvalResult.score}/10
                          </div>
                          {singleEvalResult.fullEvaluation && (
                            <Button variant="outline" onClick={() => handleExportToPdf(singleEvalResult.candidateName || 'candidate', singleEvalResult.fullEvaluation || '', singleEvalResult.interviewQuestions)}>
                              <FileDown className="mr-2 h-4 w-4" />
                              Export
                            </Button>
                          )}
                        </div>
                      </div>
                    ) : (
                      <Alert variant="destructive">
                        <AlertCircleIcon className="h-4 w-4" />
                        <AlertTitle>Evaluation failed</AlertTitle>
                        <AlertDescription>{singleEvalResult.error}</AlertDescription>
                      </Alert>
                    )}
                  </CardContent>
                </Card>
              )}

              {resumeResults.length > 0 && (
                <Card className="border-[#42C74A]/20 bg-[linear-gradient(180deg,_rgba(240,253,244,0.9),_rgba(255,255,255,0.98))] shadow-none">
                  <CardHeader className="pb-4">
                    <CardTitle className="flex items-center gap-2 text-lg">
                      <Bot className="h-4 w-4 text-[#177a2a]" />
                      AI Search Copilot
                    </CardTitle>
                    <CardDescription>
                      Ask ChatGPT to find screened candidates by fit, gaps, or recruiter priority.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="flex flex-col gap-3 lg:flex-row">
                      <Input
                        value={aiSearchQuery}
                        onChange={(event) => setAiSearchQuery(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' && !event.shiftKey) {
                            event.preventDefault();
                            if (!isRunningAiSearch && aiSearchQuery.trim() && isOpenAIReady) {
                              void handleRunAiSearch();
                            }
                          }
                        }}
                        placeholder='Try: "show candidates with client-facing solution design" or type keywords like "keyword1, keyword2, keyword3"'
                        className="flex-1"
                      />
                      <div className="flex gap-2">
                        <Button onClick={handleRunAiSearch} disabled={isRunningAiSearch || !aiSearchQuery.trim() || !isOpenAIReady}>
                          {isRunningAiSearch ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : <Bot className="mr-2 h-4 w-4" />}
                          Run AI Search
                        </Button>
                        {(aiSearchMatches.length > 0 || aiSearchSummary) && (
                          <Button
                            type="button"
                            variant="outline"
                            onClick={() => {
                              setAiSearchSummary('');
                              setAiSearchMatches([]);
                              setShowOnlyAiMatches(false);
                            }}
                          >
                            Clear
                          </Button>
                        )}
                      </div>
                    </div>

                    <div className="flex flex-wrap gap-2 text-xs">
                      {[
                        'show best candidates for recruiter screen first',
                        'find candidates who are strong but missing one requirement',
                        'show candidates with low authenticity risk and high interview readiness',
                        'keywords: keyword1, keyword2, keyword3',
                      ].map((prompt) => (
                        <button
                          key={prompt}
                          type="button"
                          onClick={() => setAiSearchQuery(prompt)}
                          className="rounded-full border border-[#42C74A]/20 bg-white px-3 py-1 text-slate-600 transition hover:bg-[#42C74A]/8 hover:text-[#177a2a]"
                        >
                          {prompt}
                        </button>
                      ))}
                    </div>

                    {(aiSearchSummary || aiSearchMatches.length > 0) && (
                      <div className="space-y-3 rounded-2xl border border-[#42C74A]/15 bg-white p-4">
                        {aiSearchSummary && <p className="text-sm text-slate-700">{aiSearchSummary}</p>}
                        <div className="flex flex-wrap items-center gap-2">
                          {aiSearchMatches.length > 0 && (
                            <Button type="button" size="sm" variant="outline" onClick={() => setShowOnlyAiMatches((current) => !current)}>
                              {showOnlyAiMatches ? 'Show all candidates' : 'Show AI matches only'}
                            </Button>
                          )}
                          {aiSearchMatches.length > 0 && (
                            <span className="text-xs text-muted-foreground">{aiSearchMatches.length} AI match{aiSearchMatches.length === 1 ? '' : 'es'} selected.</span>
                          )}
                        </div>
                        {aiSearchMatches.length > 0 && (
                          <div className="grid gap-3 lg:grid-cols-2">
                            {aiSearchMatches.slice(0, 4).map((match) => (
                              <button
                                key={match.applicationId}
                                type="button"
                                onClick={() => openReviewForCandidate(match.applicationId)}
                                className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-3 text-left transition hover:border-[#42C74A]/40 hover:bg-[#42C74A]/8"
                              >
                                <p className="text-sm font-medium text-slate-900">{match.candidateName}</p>
                                <p className="mt-1 text-sm text-slate-600">{match.rationale}</p>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </CardContent>
                </Card>
              )}

              {resumeResults.length > 0 && (
                <div className="space-y-4">
                  <div className="grid gap-3 md:grid-cols-4">
                    <div className="relative md:col-span-2">
                      <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                      <Input value={searchTerm} onChange={(event) => setSearchTerm(event.target.value)} placeholder="Search candidate, stage, source..." className="pl-10" />
                    </div>
                    <Select value={recommendationFilter} onValueChange={setRecommendationFilter}>
                      <SelectTrigger>
                        <SelectValue placeholder="Recommendation" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All recommendations</SelectItem>
                        <SelectItem value="strong_interview">Strong interview</SelectItem>
                        <SelectItem value="interview">Interview</SelectItem>
                        <SelectItem value="review">Needs review</SelectItem>
                        <SelectItem value="reject">Reject</SelectItem>
                      </SelectContent>
                    </Select>
                    <Select value={bucketFilter} onValueChange={setBucketFilter}>
                      <SelectTrigger>
                        <SelectValue placeholder="Bucket" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All buckets</SelectItem>
                        <SelectItem value="top">Top picks</SelectItem>
                        <SelectItem value="review">Needs review</SelectItem>
                        <SelectItem value="reject">Reject</SelectItem>
                        <SelectItem value="none">Unsorted</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="grid gap-3 md:grid-cols-[1fr_auto_auto_auto_auto]">
                    <Select value={stageFilter} onValueChange={setStageFilter}>
                      <SelectTrigger>
                        <SelectValue placeholder="Stage" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All stages</SelectItem>
                        {stageOptions.map((stage) => (
                          <SelectItem key={stage} value={stage}>{stage}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button variant="outline" className="border-[#42C74A]/30 text-[#177a2a] hover:bg-[#42C74A]/8" onClick={() => applyBucketToSelected('top')} disabled={selectedCandidates.size === 0}>Top Picks</Button>
                    <Button variant="outline" className="border-[#42C74A]/20 text-slate-700 hover:bg-[#42C74A]/8" onClick={() => applyBucketToSelected('review')} disabled={selectedCandidates.size === 0}>Needs Review</Button>
                    <Button variant="outline" className="border-rose-200 text-rose-700 hover:bg-rose-50" onClick={() => applyBucketToSelected('reject')} disabled={selectedCandidates.size === 0}>Reject Bucket</Button>
                    <div className="flex gap-2">
                      <CandidateCompareDialog candidates={compareCandidates} />
                      <Button variant="outline" onClick={handleExportCsv}>
                        <FileDown className="mr-2 h-4 w-4" />
                        Export CSV
                      </Button>
                    </div>
                  </div>

                  <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
                    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-slate-50 px-4 py-3">
                      <div>
                        <p className="text-sm font-semibold text-slate-900">Candidate Queue</p>
                        <p className="text-xs text-muted-foreground">Compact recruiter table for quick scanning and review.</p>
                      </div>
                      <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">{rankedResults.length} shown</p>
                    </div>

                    <Table className="table-fixed">
                      <TableHeader className="bg-white">
                        <TableRow className="hover:bg-transparent">
                          <TableHead className="w-12">
                            <Checkbox
                              checked={filteredResults.length > 0 && selectedCandidates.size === filteredResults.filter((result) => result.applicationId).length}
                              onCheckedChange={(checked) => handleSelectAll(Boolean(checked))}
                              aria-label="Select all candidates"
                            />
                          </TableHead>
                          <TableHead className="w-[18%]">Candidate</TableHead>
                          <TableHead className="w-[11%]">Stage</TableHead>
                          <TableHead className="w-[12%]">Recommendation</TableHead>
                          <TableHead className="w-[10%]">Bucket</TableHead>
                          <TableHead className="w-[8%] text-right">Score</TableHead>
                          <TableHead className="w-[12%]">Status</TableHead>
                          <TableHead className="w-[14%] text-right">Actions</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {rankedResults.map((result) => (
                          <TableRow
                            key={`${result.applicationId}-${result.fileName}`}
                            data-state={result.applicationId && selectedCandidates.has(result.applicationId) ? 'selected' : undefined}
                          >
                            <TableCell className="align-top">
                              {result.applicationId && (
                                <Checkbox
                                  checked={selectedCandidates.has(result.applicationId)}
                                  onCheckedChange={(checked) => handleSelectCandidate(result.applicationId!, Boolean(checked))}
                                  aria-label={`Select ${result.candidateName}`}
                                />
                              )}
                            </TableCell>
                            <TableCell className="align-top">
                              <div className="space-y-1 pr-2">
                                <p className="break-words font-medium text-slate-900">{result.candidateName}</p>
                                <p className="text-xs text-muted-foreground">
                                  {result.sourceName || 'Unknown source'} · CID {result.candidateId ?? 'n/a'} · AID {result.applicationId ?? 'n/a'}
                                </p>
                                {result.authenticityRisk && (
                                  <Badge variant="outline" className={`mt-1 ${getAuthenticityTone(result.authenticityRisk)}`}>
                                    {result.authenticityRisk === 'high' ? 'Verify carefully' : `${result.authenticityRisk} authenticity risk`}
                                  </Badge>
                                )}
                              </div>
                            </TableCell>
                            <TableCell className="align-top text-sm text-slate-700">
                              <span className="break-words">{result.stageName || 'Unknown'}</span>
                            </TableCell>
                            <TableCell className="align-top">
                              {result.recommendation ? (
                                <Badge className={getRecommendationTone(result.recommendation)}>
                                  {recommendationCopy[result.recommendation]}
                                </Badge>
                              ) : (
                                <span className="text-sm text-muted-foreground">{result.status === 'processing' ? 'Evaluating' : 'Not scored'}</span>
                              )}
                            </TableCell>
                            <TableCell className="align-top">
                              <Badge variant="outline" className="border-slate-200 bg-white text-slate-700">
                                {bucketCopy[result.bucket as CandidateBucket]}
                              </Badge>
                            </TableCell>
                            <TableCell className="align-top text-right">
                              {typeof result.score === 'number' ? (
                                <span className={`inline-flex rounded-full px-3 py-1 text-sm font-semibold ${getScoreTone(result.score)}`}>
                                  {result.score}/10
                                </span>
                              ) : (
                                <span className="text-sm text-muted-foreground">-</span>
                              )}
                            </TableCell>
                            <TableCell className="align-top text-sm">
                              {result.status === 'error' ? (
                                <span className="break-words text-rose-600">{result.error || 'Evaluation failed.'}</span>
                              ) : result.status === 'processing' ? (
                                <span className="text-sky-600">Evaluating...</span>
                              ) : result.status === 'success' ? (
                                <span className="text-emerald-600">Ready</span>
                              ) : (
                                <span className="text-muted-foreground">Queued</span>
                              )}
                            </TableCell>
                            <TableCell className="align-top">
                              <div className="flex flex-wrap justify-end gap-2">
                                {result.url && result.url !== '#' && (
                                  <ResumePreviewDialog url={result.url} fileName={result.fileName} />
                                )}
                                {result.status === 'success' && result.fullEvaluation ? (
                                  <EvaluationViewer
                                    result={result}
                                    notes={result.notes}
                                    bucket={result.bucket as CandidateBucket}
                                    greenhouseUsers={greenhouseUsers}
                                    outreachConfigured={Boolean(serverConfig.outreachConfigured)}
                                    notifyTaggedTeammate={notifyTaggedTeammate}
                                    noteAuthorId={selectedNoteAuthorId}
                                    taggedUserId={result.applicationId ? (taggedUserByApplication[result.applicationId] || 'none') : 'none'}
                                    onNotesChange={(notes) => result.applicationId && updateCandidateMeta(result.applicationId, { notes })}
                                    onBucketChange={(bucket) => result.applicationId && updateCandidateMeta(result.applicationId, { bucket })}
                                    onNoteAuthorChange={setSelectedNoteAuthorId}
                                    onTaggedUserChange={(userId) => {
                                      if (!result.applicationId) return;
                                      setTaggedUserByApplication((previous) => ({
                                        ...previous,
                                        [result.applicationId!]: userId,
                                      }));
                                    }}
                                    onNotifyTaggedTeammateChange={setNotifyTaggedTeammate}
                                    onSaveGreenhouseNote={() => handleSaveGreenhouseNote(result, result.notes || '')}
                                    onExportPdf={() => handleExportToPdf(result.candidateName || 'candidate', result.fullEvaluation || '', result.interviewQuestions)}
                                    canGoPrevious={activeReviewIndex > 0}
                                    canGoNext={activeReviewIndex >= 0 && activeReviewIndex < reviewableResults.length - 1}
                                    onPrevious={() => goToAdjacentReview('previous')}
                                    onNext={() => goToAdjacentReview('next')}
                                    open={activeReviewApplicationId === result.applicationId}
                                    onOpenChange={(open) => {
                                      if (open) {
                                        openReviewForCandidate(result.applicationId);
                                      } else if (activeReviewApplicationId === result.applicationId) {
                                        setActiveReviewApplicationId(null);
                                      }
                                    }}
                                  />
                                ) : null}
                                {result.status === 'error' && result.url && result.url !== '#' ? (
                                  <Button size="sm" variant="outline" onClick={() => handleRetryEvaluation(resumeResults.findIndex((item) => item.applicationId === result.applicationId))}>
                                    <RefreshCw className="mr-2 h-4 w-4" />
                                    Retry
                                  </Button>
                                ) : null}
                              </div>
                            </TableCell>
                          </TableRow>
                        ))}
                        {rankedResults.length === 0 && (
                          <TableRow>
                            <TableCell colSpan={9} className="py-12 text-center text-muted-foreground">
                              No candidates match the current filters.
                            </TableCell>
                          </TableRow>
                        )}
                      </TableBody>
                    </Table>
                  </div>

                  {rejectionReasons.length > 0 && (
                    <Card className="border-rose-200 bg-rose-50/50 shadow-none">
                      <CardHeader>
                        <CardTitle className="flex items-center gap-2 text-lg">
                          <Send className="h-4 w-4" />
                          Safe Bulk Rejection
                        </CardTitle>
                        <CardDescription>Select a reason and template before triggering Greenhouse rejections.</CardDescription>
                      </CardHeader>
                      <CardContent className="grid gap-4 md:grid-cols-2">
                        <div className="space-y-2">
                          <Label>Rejection Reason</Label>
                          <Select value={selectedRejectionReason} onValueChange={setSelectedRejectionReason}>
                            <SelectTrigger>
                              <SelectValue placeholder="Choose a reason..." />
                            </SelectTrigger>
                            <SelectContent>
                              {rejectionReasons.map((reason) => (
                                <SelectItem key={reason.id} value={String(reason.id)}>
                                  {reason.name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="space-y-2">
                          <Label>Email Template</Label>
                          <Select value={selectedEmailTemplate} onValueChange={setSelectedEmailTemplate}>
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="-1">Default candidate rejection</SelectItem>
                              {emailTemplates.map((template) => (
                                <SelectItem key={template.id} value={String(template.id)}>
                                  {template.name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      </CardContent>
                      <CardFooter>
                        <Button variant="destructive" onClick={handleSendRejections} disabled={selectedCandidates.size === 0 || !selectedRejectionReason || isSendingRejections}>
                          {isSendingRejections ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />}
                          Send {selectedCandidates.size} Rejection Email(s)
                        </Button>
                      </CardFooter>
                    </Card>
                  )}

                  <Card className="border-teal-200 bg-[linear-gradient(180deg,_rgba(240,253,250,0.92),_rgba(255,255,255,0.98))] shadow-none">
                    <CardHeader>
                      <CardTitle className="flex items-center gap-2 text-lg">
                        <Mail className="h-4 w-4 text-teal-700" />
                        Candidate Outreach Studio
                      </CardTitle>
                      <CardDescription>
                        Build personalized outreach for shortlisted candidates. You can send directly from the app when the server has <code>RESEND_API_KEY</code> and <code>OUTREACH_FROM_EMAIL</code> configured.
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-5">
                      <div className="rounded-xl border border-slate-200 bg-white/80 px-4 py-3 text-sm text-slate-600">
                        Direct sending: <strong>{serverConfig.outreachConfigured ? 'Configured' : 'Not configured'}</strong>
                        {!serverConfig.outreachConfigured ? ' - add RESEND_API_KEY and OUTREACH_FROM_EMAIL to your server env to send straight from the app.' : ''}
                      </div>
                      <div className="grid gap-4 lg:grid-cols-3">
                        <div className="space-y-2">
                          <Label htmlFor="recruiter-name">Recruiter Name</Label>
                          <Input id="recruiter-name" value={recruiterName} onChange={(event) => setRecruiterName(event.target.value)} placeholder="Jane Smith" />
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="recruiter-title">Recruiter Title</Label>
                          <Input id="recruiter-title" value={recruiterTitle} onChange={(event) => setRecruiterTitle(event.target.value)} placeholder="Senior Recruiter" />
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="calendar-link">Calendar Link</Label>
                          <Input id="calendar-link" value={calendarLink} onChange={(event) => setCalendarLink(event.target.value)} placeholder="https://cal.com/your-name/intro-call" />
                        </div>
                      </div>

                      <div className="space-y-2">
                        <Label htmlFor="outreach-template">Message Template</Label>
                        <Textarea
                          id="outreach-template"
                          value={outreachTemplate}
                          onChange={(event) => setOutreachTemplate(event.target.value)}
                          className="min-h-44"
                        />
                        <p className="text-xs text-muted-foreground">
                          Supported variables: <code>{'{{candidateFirstName}}'}</code>, <code>{'{{jobTitle}}'}</code>, <code>{'{{calendarLink}}'}</code>, <code>{'{{recruiterName}}'}</code>, <code>{'{{recruiterTitle}}'}</code>, <code>{'{{personalizedLine}}'}</code>
                        </p>
                      </div>

                      <div className="space-y-3">
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <p className="text-sm font-medium text-slate-900">
                            Outreach candidates: {outreachCandidates.length}
                          </p>
                          <div className="flex flex-wrap items-center gap-3">
                            <p className="text-xs text-muted-foreground">
                              Uses selected candidates first, then falls back to the <code>Top picks</code> bucket.
                            </p>
                            <Button size="sm" onClick={handleSendBulkOutreach} disabled={!serverConfig.outreachConfigured || isSendingOutreach || outreachCandidates.length === 0}>
                              {isSendingOutreach ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />}
                              Send All
                            </Button>
                          </div>
                        </div>

                        {outreachCandidates.length === 0 ? (
                          <div className="rounded-xl border border-dashed border-slate-300 bg-white/80 px-4 py-6 text-sm text-muted-foreground">
                            Select candidates in the dashboard or move them to <strong>Top picks</strong> to prepare outreach.
                          </div>
                        ) : (
                          <div className="space-y-3">
                            {outreachCandidates.map((candidate) => (
                              <Card key={`outreach-${candidate.applicationId}`} className="border-white/80 bg-white/90 shadow-sm">
                                <CardContent className="p-5">
                                  <div className="flex flex-wrap items-start justify-between gap-4">
                                    <div className="space-y-2">
                                      <div className="flex flex-wrap items-center gap-2">
                                        <p className="text-lg font-semibold text-slate-900">{candidate.candidateName}</p>
                                        {candidate.recommendation && (
                                          <Badge className={getRecommendationTone(candidate.recommendation)}>
                                            {recommendationCopy[candidate.recommendation]}
                                          </Badge>
                                        )}
                                      </div>
                                      <p className="text-sm text-slate-600">
                                        {candidate.candidateEmail || 'No email detected in Greenhouse for this candidate.'}
                                      </p>
                                      <p className="text-sm text-slate-500">{candidate.evaluationSummary || 'No evaluation summary available yet.'}</p>
                                    </div>
                                    <div className="flex flex-wrap gap-2">
                                      <Button variant="outline" size="sm" onClick={() => handleCopyOutreach(candidate)}>
                                        <Copy className="mr-2 h-4 w-4" />
                                        Copy Draft
                                      </Button>
                                      <Button size="sm" onClick={() => handleOpenMailDraft(candidate)} disabled={!candidate.candidateEmail}>
                                        <Mail className="mr-2 h-4 w-4" />
                                        Open Email Draft
                                      </Button>
                                      <Button size="sm" variant="outline" onClick={() => handleSendOutreach(candidate)} disabled={!serverConfig.outreachConfigured || !candidate.candidateEmail || isSendingOutreach}>
                                        {isSendingOutreach ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />}
                                        Send Now
                                      </Button>
                                    </div>
                                  </div>
                                  <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm whitespace-pre-wrap text-slate-700">
                                    {buildOutreachMessage(candidate)}
                                  </div>
                                </CardContent>
                              </Card>
                            ))}
                          </div>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      <AnimatePresence>
        {isFetchingResumes && resumeResults.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -12 }}
          >
            <Card className="border-white/70 bg-white/80 shadow-sm">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-xl">
                  <Clock className="h-5 w-5 text-teal-600" />
                  Live Processing Queue
                </CardTitle>
                <CardDescription>Parallel evaluation runs update this queue as each resume completes.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {resumeResults.map((result) => (
                  <div key={`${result.applicationId}-${result.fileName}`} className="flex items-center justify-between rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
                    <div>
                      <p className="font-medium text-slate-900">{result.candidateName}</p>
                      <p className="text-sm text-slate-500">{result.stageName || result.fileName}</p>
                    </div>
                    <div className="flex items-center gap-3">
                      {result.status === 'processing' && <LoaderCircle className="h-4 w-4 animate-spin text-teal-600" />}
                      {result.status === 'success' && <CheckCircle2 className="h-4 w-4 text-emerald-600" />}
                      {result.status === 'error' && <XCircle className="h-4 w-4 text-rose-600" />}
                      <span className="text-sm text-slate-600">
                        {result.status === 'processing' ? 'Evaluating' : result.status === 'success' ? 'Done' : result.status === 'error' ? 'Needs attention' : 'Queued'}
                      </span>
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
