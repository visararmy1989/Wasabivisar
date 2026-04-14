
'use server';

import { z } from 'zod';
import type { GreenhouseJob, RateLimitInfo, GreenhouseApplication, ResumeResult, GreenhouseJobPost, RejectionReason, EmailTemplate, GreenhouseUser } from '@/lib/types';
import { JSDOM } from 'jsdom';
import { evaluateResumeWithOpenAI }from '@/app/openaiActions';

const BASE_URL = 'https://harvest.greenhouse.io/v1';

const ApiKeySchema = z.string().min(1, 'API Key is required.');

function resolveGreenhouseApiKey(apiKey?: string) {
  return (
    apiKey ||
    process.env.GREENHOUSE_API_KEY ||
    process.env.GREENHOUSE_HARVEST_API_KEY ||
    ''
  );
}

export async function getServerConfigStatus() {
  return {
    greenhouseConfigured: !!resolveGreenhouseApiKey(),
    openAIConfigured: !!(
      process.env.OPENAI_API_KEY ||
      process.env.OPENAI_EVAL_API_KEY
    ),
    outreachConfigured: !!(
      process.env.RESEND_API_KEY &&
      (process.env.OUTREACH_FROM_EMAIL || process.env.RESEND_FROM_EMAIL)
    ),
  };
}

const OutreachPayloadSchema = z.object({
  to: z.string().email(),
  subject: z.string().min(1),
  message: z.string().min(1),
  candidateName: z.string().min(1),
});

export async function sendOutreachEmails(payloads: Array<z.infer<typeof OutreachPayloadSchema>>): Promise<{
  success: boolean;
  error?: string;
  sentCount?: number;
  failed?: Array<{ to: string; error: string }>;
}> {
  const resendApiKey = process.env.RESEND_API_KEY;
  const fromEmail = process.env.OUTREACH_FROM_EMAIL || process.env.RESEND_FROM_EMAIL;
  const replyToEmail = process.env.OUTREACH_REPLY_TO_EMAIL || process.env.RESEND_REPLY_TO_EMAIL;

  if (!resendApiKey || !fromEmail) {
    return {
      success: false,
      error: 'Direct email sending is not configured. Set RESEND_API_KEY and OUTREACH_FROM_EMAIL on the server.',
    };
  }

  const parsedPayloads = z.array(OutreachPayloadSchema).safeParse(payloads);
  if (!parsedPayloads.success) {
    return {
      success: false,
      error: parsedPayloads.error.errors.map((item) => item.message).join(', '),
    };
  }

  const failed: Array<{ to: string; error: string }> = [];
  let sentCount = 0;

  for (const payload of parsedPayloads.data) {
    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${resendApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: fromEmail,
          to: [payload.to],
          subject: payload.subject,
          text: payload.message,
          reply_to: replyToEmail ? [replyToEmail] : undefined,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        failed.push({
          to: payload.to,
          error: errorData?.message || `Failed with status ${response.status}`,
        });
        continue;
      }

      sentCount += 1;
    } catch (error) {
      failed.push({
        to: payload.to,
        error: error instanceof Error ? error.message : 'Unknown send error',
      });
    }
  }

  return {
    success: failed.length === 0,
    sentCount,
    failed,
    error: failed.length > 0 ? `${failed.length} email(s) failed to send.` : undefined,
  };
}

function getAuthHeader(apiKey: string) {
  return {
    'Authorization': `Basic ${btoa(`${apiKey}:`)}`,
    'Content-Type': 'application/json',
  };
}

function getAuthHeaderWithOnBehalfOf(apiKey: string, userId: number) {
  return {
    ...getAuthHeader(apiKey),
    'On-Behalf-Of': String(userId),
  };
}

function getRateLimitFromHeaders(headers: Headers): RateLimitInfo {
  return {
    limit: Number(headers.get('x-ratelimit-limit')),
    remaining: Number(headers.get('x-ratelimit-remaining')),
    reset: Number(headers.get('x-ratelimit-reset')),
  };
}

// Helper function to parse the Link header for pagination
function parseLinkHeader(header: string | null): { [key: string]: string } {
    if (!header) {
        return {};
    }

    const links: { [key: string]: string } = {};
    const parts = header.split(',');

    parts.forEach(part => {
        const section = part.split(';');
        if (section.length < 2) {
            return;
        }

        const urlMatch = section[0].match(/<(.*)>/);
        if (!urlMatch) {
            return;
        }
        const url = urlMatch[1];

        const relMatch = section[1].match(/rel="(.*)"/);
        if (!relMatch) {
            return;
        }
        const rel = relMatch[1];

        links[rel] = url;
    });

    return links;
}

function isLikelyResumeAttachment(attachment: {
  filename?: string;
  type?: string;
  url?: string;
}) {
  if (!attachment.url) {
    return false;
  }

  const fileName = (attachment.filename || '').toLowerCase();
  const type = (attachment.type || '').toLowerCase();

  const explicitResumeTypes = new Set(['resume', 'docx', 'attachment', 'other']);
  const likelyResumeName =
    fileName.includes('resume') ||
    fileName.includes('cv') ||
    fileName.endsWith('.pdf') ||
    fileName.endsWith('.doc') ||
    fileName.endsWith('.docx') ||
    fileName.endsWith('.rtf') ||
    fileName.endsWith('.txt');

  return explicitResumeTypes.has(type) || likelyResumeName;
}

function getBestResumeAttachment(app: GreenhouseApplication) {
  const attachments = Array.isArray(app.attachments) ? app.attachments : [];

  const scored = attachments
    .filter((attachment) => attachment?.url)
    .map((attachment) => {
      const fileName = (attachment.filename || '').toLowerCase();
      const type = (attachment.type || '').toLowerCase();

      let score = 0;

      if (type === 'resume') score += 10;
      if (type === 'docx') score += 7;
      if (fileName.includes('resume')) score += 8;
      if (fileName.includes('cv')) score += 7;
      if (fileName.endsWith('.pdf')) score += 6;
      if (fileName.endsWith('.doc') || fileName.endsWith('.docx')) score += 5;
      if (fileName.endsWith('.rtf') || fileName.endsWith('.txt')) score += 2;
      if (type === 'cover_letter') score -= 20;
      if (fileName.includes('cover')) score -= 20;
      if (type === 'portfolio') score -= 5;

      return { attachment, score };
    })
    .filter(({ attachment, score }) => score > 0 || isLikelyResumeAttachment(attachment))
    .sort((a, b) => b.score - a.score);

  return scored[0]?.attachment;
}

function getCandidateEmail(app: GreenhouseApplication) {
  const candidate = app.candidate || {};
  const directEmail = typeof candidate.email === 'string' ? candidate.email : '';
  if (directEmail) {
    return directEmail;
  }

  const emailAddresses = Array.isArray(candidate.email_addresses) ? candidate.email_addresses : [];
  const found = emailAddresses.find((entry) => entry?.value || entry?.address);
  return found?.value || found?.address || '';
}

function formatCandidateName(app: GreenhouseApplication) {
  const firstName = typeof app.candidate?.first_name === 'string' ? app.candidate.first_name.trim() : '';
  const lastName = typeof app.candidate?.last_name === 'string' ? app.candidate.last_name.trim() : '';
  const fullName = `${firstName} ${lastName}`.trim();

  if (fullName) {
    return fullName;
  }

  const email = getCandidateEmail(app);
  if (email.includes('@')) {
    const localPart = email.split('@')[0] || '';
    const normalized = localPart
      .replace(/[._-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (normalized) {
      return normalized.replace(/\b\w/g, (char) => char.toUpperCase());
    }
  }

  const bestAttachment = getBestResumeAttachment(app);
  const fileStem = (bestAttachment?.filename || '')
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/\b(resume|cv|curriculum vitae)\b/gi, '')
    .replace(/[._-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (fileStem) {
    return fileStem.replace(/\b\w/g, (char) => char.toUpperCase());
  }

  return `Application ID ${app.id}`;
}


export async function getJobs(apiKey: string): Promise<{
  success: boolean;
  error?: string;
  jobs?: GreenhouseJob[];
  rateLimit?: RateLimitInfo;
}> {
  const resolvedApiKey = resolveGreenhouseApiKey(apiKey);
  const validation = ApiKeySchema.safeParse(resolvedApiKey);
  if (!validation.success) {
    return { success: false, error: 'Greenhouse API key is missing. Configure it on the server or enter one for this session.' };
  }

  try {
    const response = await fetch(`${BASE_URL}/jobs?status=open`, {
      headers: getAuthHeader(resolvedApiKey),
    });
    
    const rateLimit = getRateLimitFromHeaders(response.headers);

    if (!response.ok) {
      if (response.status === 401) {
        return { success: false, error: 'Invalid API Key.', rateLimit };
      }
      const errorText = await response.text();
      console.error(`Failed to fetch jobs. Status: ${response.status}`, errorText);
      return { success: false, error: `Failed to fetch jobs. Status: ${response.status}`, rateLimit };
    }

    const jobs: GreenhouseJob[] = await response.json();
    return { success: true, jobs, rateLimit };
  } catch (error) {
    console.error('Error fetching jobs:', error);
    return { success: false, error: 'An unexpected error occurred.' };
  }
}

export async function getJobDetails(jobId: number, apiKey: string): Promise<{
  success: boolean;
  error?: string;
  job?: GreenhouseJob;
  rateLimit?: RateLimitInfo;
}> {
    const resolvedApiKey = resolveGreenhouseApiKey(apiKey);
    const validation = ApiKeySchema.safeParse(resolvedApiKey);
    if (!validation.success) {
        return { success: false, error: 'Greenhouse API key is missing. Configure it on the server or enter one for this session.' };
    }
    
    try {
        const response = await fetch(`${BASE_URL}/jobs/${jobId}`, {
            headers: getAuthHeader(resolvedApiKey),
        });

        const rateLimit = getRateLimitFromHeaders(response.headers);

        if (!response.ok) {
            const errorText = await response.text();
            console.error(`Failed to fetch job details. Status: ${response.status}`, errorText);
            return { success: false, error: `Failed to fetch job details. Status: ${response.status}`, rateLimit };
        }
        
        const job: GreenhouseJob = await response.json();

        if (job.content) {
            const dom = new JSDOM(job.content);
            const document = dom.window.document;
            job.content = document.body.textContent || "";
        }

        return { success: true, job, rateLimit };

    } catch (error) {
        console.error(`Error fetching job details for job ID ${jobId}:`, error);
        return { success: false, error: 'An unexpected error occurred while fetching job details.' };
    }
}

export async function getLatestJobPost(jobId: number, apiKey: string): Promise<{
    success: boolean;
    error?: string;
    content?: string;
    rateLimit?: RateLimitInfo;
}> {
    const resolvedApiKey = resolveGreenhouseApiKey(apiKey);
    const validation = ApiKeySchema.safeParse(resolvedApiKey);
    if (!validation.success) {
        return { success: false, error: 'Greenhouse API key is missing. Configure it on the server or enter one for this session.' };
    }

    try {
        const response = await fetch(`${BASE_URL}/jobs/${jobId}/job_posts`, {
            headers: getAuthHeader(resolvedApiKey),
        });

        const rateLimit = getRateLimitFromHeaders(response.headers);

        if (!response.ok) {
            if (response.status === 403) {
                 return { success: true, content: 'Your API key does not have permission to access job posts. Using internal job content as a fallback.', rateLimit };
            }
            const errorText = await response.text();
            console.error(`Failed to fetch job posts. Status: ${response.status}`, errorText);
            return { success: false, error: `Failed to fetch job posts. Status: ${response.status}`, rateLimit };
        }

        const jobPosts: GreenhouseJobPost[] = await response.json();
        
        if (!jobPosts || jobPosts.length === 0) {
            return { success: true, content: 'No job posts found for this job.', rateLimit };
        }

        jobPosts.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
        
        const latestPost = jobPosts[0];
        
        let plainTextContent = latestPost.content;
        if (plainTextContent) {
            const dom = new JSDOM(plainTextContent);
            plainTextContent = dom.window.document.body.textContent || "";
        }

        return { success: true, content: plainTextContent, rateLimit };

    } catch (error) {
        console.error(`Error fetching job posts for job ID ${jobId}:`, error);
        return { success: false, error: 'An unexpected error occurred while fetching job posts.' };
    }
}


export async function getResumesForJob(
  jobId: number,
  apiKey: string,
  status: string,
): Promise<{
  success: boolean;
  error?: string;
  message?: string;
  rateLimit?: RateLimitInfo;
  resumeResults?: ResumeResult[];
  rawResponse?: string;
}> {
  const resolvedApiKey = resolveGreenhouseApiKey(apiKey);
  const validation = ApiKeySchema.safeParse(resolvedApiKey);
  if (!validation.success) {
    return { success: false, error: 'Greenhouse API key is missing. Configure it on the server or enter one for this session.' };
  }

  try {
    let allApplications: GreenhouseApplication[] = [];
    let rateLimit: RateLimitInfo | null = null;
    
    let url = `${BASE_URL}/applications?job_id=${jobId}&per_page=100`;
    if (status && status !== 'all') {
      url += `&status=${status}`;
    }
    
    let nextUrl: string | null = url;

    while (nextUrl) {
        const applicationsRes = await fetch(nextUrl, {
            headers: getAuthHeader(resolvedApiKey),
        });
        
        rateLimit = getRateLimitFromHeaders(applicationsRes.headers);

        if (!applicationsRes.ok) {
            const errorBody = await applicationsRes.text();
            console.error("Failed to fetch applications:", errorBody);
            return { success: false, error: `API error: ${applicationsRes.status} - ${errorBody}`, rateLimit: rateLimit ?? undefined };
        }

        const applications: GreenhouseApplication[] = await applicationsRes.json();
        allApplications = allApplications.concat(applications);
        
        const linkHeader = applicationsRes.headers.get('Link');
        const links = parseLinkHeader(linkHeader);
        nextUrl = links.next || null;
    }

    const rawResponse = JSON.stringify(allApplications, null, 2);

    if (allApplications.length === 0) {
      return { success: true, message: 'No applications found for this job with the selected filter.', rateLimit: rateLimit ?? undefined, resumeResults: [], rawResponse };
    }

    const resumeResults: ResumeResult[] = [];

    allApplications.forEach((app) => {
      const candidateName = formatCandidateName(app);

      const bestAttachment = getBestResumeAttachment(app);

      if (bestAttachment?.url) {
        resumeResults.push({
          success: true,
          fileName: bestAttachment.filename,
          url: bestAttachment.url,
          candidateName,
          candidateId: app.candidate?.id || app.candidate_id,
          candidateEmail: getCandidateEmail(app),
          applicationId: app.id,
          applicationStatus: app.status || 'unknown',
          stageName: app.current_stage?.name || 'Unknown stage',
          sourceName: app.source?.public_name || 'Unknown source',
        });
      } else {
        resumeResults.push({
          success: false,
          fileName: `For ${candidateName}`,
          error: 'No resume attachment detected. This candidate may only have a cover letter or a non-standard attachment type.',
          url: '#',
          candidateName,
          candidateId: app.candidate?.id || app.candidate_id,
          candidateEmail: getCandidateEmail(app),
          applicationId: app.id,
          applicationStatus: app.status || 'unknown',
            stageName: app.current_stage?.name || 'Unknown stage',
            sourceName: app.source?.public_name || 'Unknown source',
          });
      }
    });

    const successfulResults = resumeResults.filter(r => r.success).length;

    return { 
        success: true, 
        message: `Processed ${allApplications.length} applications. Found ${successfulResults} resumes.`,
        rateLimit: rateLimit ?? undefined,
        resumeResults,
        rawResponse
    };
  } catch (error) {
    if (error instanceof Error) {
        console.error('Error fetching resumes:', error.message);
        console.error('Stack trace:', error.stack);
    } else {
        console.error('An unknown error occurred:', error);
    }
    return { success: false, error: 'An unexpected error occurred during the process.' };
  }
}

export async function getApplicationCandidateId(
  apiKey: string,
  applicationId: number,
): Promise<{
  success: boolean;
  candidateId?: number;
  error?: string;
  rateLimit?: RateLimitInfo;
}> {
  const resolvedApiKey = resolveGreenhouseApiKey(apiKey);
  const validation = ApiKeySchema.safeParse(resolvedApiKey);
  if (!validation.success) {
    return { success: false, error: 'Greenhouse API key is missing. Configure it on the server or enter one for this session.' };
  }

  try {
    const response = await fetch(`${BASE_URL}/applications/${applicationId}`, {
      headers: getAuthHeader(resolvedApiKey),
    });

    const rateLimit = getRateLimitFromHeaders(response.headers);

    if (!response.ok) {
      const errorText = await response.text();
      return { success: false, error: `Failed to fetch application: ${errorText}`, rateLimit };
    }

    const application: GreenhouseApplication = await response.json();
    const candidateId = application.candidate?.id || application.candidate_id;

    if (!candidateId) {
      return { success: false, error: 'Greenhouse did not return a candidate id for this application.', rateLimit };
    }

    return { success: true, candidateId, rateLimit };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to fetch application details.',
    };
  }
}

export async function getUsers(apiKey: string): Promise<{
  success: boolean;
  users?: GreenhouseUser[];
  error?: string;
  rateLimit?: RateLimitInfo;
}> {
  const resolvedApiKey = resolveGreenhouseApiKey(apiKey);
  const validation = ApiKeySchema.safeParse(resolvedApiKey);
  if (!validation.success) {
    return { success: false, error: 'Greenhouse API key is missing. Configure it on the server or enter one for this session.' };
  }

  try {
    let nextUrl: string | null = `${BASE_URL}/users?per_page=100`;
    let rateLimit: RateLimitInfo | undefined;
    const allUsers: GreenhouseUser[] = [];

    while (nextUrl) {
      const response = await fetch(nextUrl, {
        headers: getAuthHeader(resolvedApiKey),
      });
      rateLimit = getRateLimitFromHeaders(response.headers);

      if (!response.ok) {
        const errorText = await response.text();
        return { success: false, error: `Failed to fetch users: ${errorText}`, rateLimit };
      }

      const users: GreenhouseUser[] = await response.json();
      allUsers.push(...users);

      const linkHeader = response.headers.get('Link');
      const links = parseLinkHeader(linkHeader);
      nextUrl = links.next || null;
    }

    return {
      success: true,
      users: allUsers.filter((user) => !user.disabled),
      rateLimit,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
    return { success: false, error: errorMessage };
  }
}

export async function addCandidateNote(
  apiKey: string,
  candidateId: number,
  userId: number,
  noteBody: string,
): Promise<{
  success: boolean;
  error?: string;
  rateLimit?: RateLimitInfo;
}> {
  const resolvedApiKey = resolveGreenhouseApiKey(apiKey);
  const validation = ApiKeySchema.safeParse(resolvedApiKey);
  if (!validation.success) {
    return { success: false, error: 'Greenhouse API key is missing. Configure it on the server or enter one for this session.' };
  }

  if (!candidateId || !userId || !noteBody.trim()) {
    return { success: false, error: 'Candidate, note author, and note body are required.' };
  }

  try {
    const postNote = async (payload: Record<string, unknown>) =>
      fetch(`${BASE_URL}/candidates/${candidateId}/activity_feed/notes`, {
        method: 'POST',
        headers: getAuthHeaderWithOnBehalfOf(resolvedApiKey, userId),
        body: JSON.stringify(payload),
      });

    let response = await postNote({
      user_id: userId,
      body: noteBody,
      visibility: 'admin_only',
      visiblity: 'admin_only',
    });

    const rateLimit = getRateLimitFromHeaders(response.headers);

    if (!response.ok) {
      const errorText = await response.text();

      if (errorText.includes('Missing required field: visibility')) {
        response = await postNote({
          user_id: userId,
          body: noteBody,
          visibility: 'private',
          visiblity: 'private',
        });

        if (response.ok) {
          return { success: true, rateLimit: getRateLimitFromHeaders(response.headers) };
        }
      }

      return { success: false, error: `Failed to add note: ${errorText}`, rateLimit };
    }

    return { success: true, rateLimit };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
    return { success: false, error: errorMessage };
  }
}

export async function evaluateSingleResume(formData: FormData) {
  const file = formData.get('file') as File;
  const openAIApiKey = formData.get('openAIApiKey') as string;
  const aiContext = formData.get('aiContext') as string;
  const liveJobDescription = formData.get('liveJobDescription') as string;

  if (!file) {
    return { success: false, error: 'No file provided.' };
  }
   if (!openAIApiKey && !process.env.OPENAI_API_KEY && !process.env.OPENAI_EVAL_API_KEY) {
    return { success: false, error: 'OpenAI API key is missing. Configure it on the server or enter one for this session.' };
  }
   if (!aiContext && !liveJobDescription) {
    return { success: false, error: 'Evaluation context is missing.' };
  }

  try {
    const buffer = Buffer.from(await file.arrayBuffer());

    const result = await evaluateResumeWithOpenAI(
      openAIApiKey,
      buffer,
      file.name,
      aiContext,
      liveJobDescription
    );

    return result;

  } catch(e) {
    const error = e instanceof Error ? e.message : 'An unknown error occurred during single resume evaluation.';
    console.error(error);
    return { success: false, error };
  }
}

export async function getRejectionReasons(apiKey: string): Promise<{
  success: boolean;
  reasons?: RejectionReason[];
  error?: string;
  rateLimit?: RateLimitInfo;
}> {
  const resolvedApiKey = resolveGreenhouseApiKey(apiKey);
  const validation = ApiKeySchema.safeParse(resolvedApiKey);
  if (!validation.success) {
    return { success: false, error: 'Greenhouse API key is missing. Configure it on the server or enter one for this session.' };
  }

  try {
    const response = await fetch(`${BASE_URL}/rejection_reasons?include_defaults=true`, {
      headers: getAuthHeader(resolvedApiKey),
    });
    const rateLimit = getRateLimitFromHeaders(response.headers);

    if (!response.ok) {
      const errorText = await response.text();
      return { success: false, error: `Failed to fetch rejection reasons: ${errorText}`, rateLimit };
    }

    const reasons: RejectionReason[] = await response.json();
    return { success: true, reasons, rateLimit };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
    return { success: false, error: errorMessage };
  }
}

export async function getEmailTemplates(apiKey: string): Promise<{
  success: boolean;
  templates?: EmailTemplate[];
  error?: string;
  rateLimit?: RateLimitInfo;
}> {
  const resolvedApiKey = resolveGreenhouseApiKey(apiKey);
  const validation = ApiKeySchema.safeParse(resolvedApiKey);
  if (!validation.success) {
    return { success: false, error: 'Greenhouse API key is missing. Configure it on the server or enter one for this session.' };
  }

  try {
    const response = await fetch(`${BASE_URL}/email_templates?type=rejection`, {
      headers: getAuthHeader(resolvedApiKey),
    });
    const rateLimit = getRateLimitFromHeaders(response.headers);

    if (!response.ok) {
      const errorText = await response.text();
      return { success: false, error: `Failed to fetch email templates: ${errorText}`, rateLimit };
    }

    let templates: EmailTemplate[] = await response.json();
    
    // Filter for rejection templates if the API returns other types
    templates = templates.filter(t => t.type === 'rejection');

    return { success: true, templates, rateLimit };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
    return { success: false, error: errorMessage };
  }
}

export async function rejectApplication(
  apiKey: string,
  applicationId: number,
  rejectionReasonId: number,
  emailTemplateId: number | null,
): Promise<{
  success: boolean;
  error?: string;
  rateLimit?: RateLimitInfo;
}> {
    const resolvedApiKey = resolveGreenhouseApiKey(apiKey);
    const validation = ApiKeySchema.safeParse(resolvedApiKey);
    if (!validation.success) {
        return { success: false, error: 'Greenhouse API key is missing. Configure it on the server or enter one for this session.' };
    }
    
    const payload: {
        rejection_reason_id: number;
        send_email: boolean;
        email_template_id?: number;
    } = {
        rejection_reason_id: rejectionReasonId,
        send_email: true,
    };

    if (emailTemplateId !== null && emailTemplateId !== -1) {
        payload.email_template_id = emailTemplateId;
    }

    try {
        const response = await fetch(`${BASE_URL}/applications/${applicationId}/reject`, {
            method: 'POST',
            headers: getAuthHeader(resolvedApiKey),
            body: JSON.stringify(payload),
        });

        const rateLimit = getRateLimitFromHeaders(response.headers);

        if (!response.ok) {
            const errorText = await response.json();
            console.error(`Failed to reject application ${applicationId}. Status: ${response.status}`, errorText);
            return { success: false, error: `Failed to reject application: ${errorText?.errors?.[0]?.message || response.statusText}`, rateLimit };
        }
        
        return { success: true, rateLimit };

    } catch (error) {
        console.error(`Error rejecting application ${applicationId}:`, error);
        return { success: false, error: 'An unexpected error occurred while rejecting application.' };
    }
}
