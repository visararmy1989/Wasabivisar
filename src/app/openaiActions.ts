
'use server';

import { z } from 'zod';
import { JSDOM } from 'jsdom';
import type { CandidateSearchMatch } from '@/lib/types';

const OPENAI_API_URL = 'https://api.openai.com/v1';

function resolveOpenAIApiKey(apiKey?: string) {
    return (apiKey || process.env.OPENAI_API_KEY || process.env.OPENAI_EVAL_API_KEY || '').trim();
}

const EvaluateResumeSchema = z.object({
    apiKey: z.string().min(1, 'OpenAI API Key is required.'),
    resumeUrl: z.string().url('A valid resume URL is required.').optional(),
    resumeBuffer: z.any().optional(),
    fileName: z.string().min(1, 'Filename cannot be empty.'),
    aiContext: z.string().min(1, 'AI evaluation context cannot be empty.'),
    liveJobDescription: z.string().optional(),
});

const EvaluationResponseSchema = z.object({
    score: z.coerce.number().min(1).max(10).describe('An integer between 1 and 10, representing the overall fit score.'),
    evaluationSummary: z.string().default('Evaluation summary unavailable.').describe('A concise, one-to-three sentence summary of the evaluation for CSV export.'),
    fullEvaluation: z.string().default('<h3>Evaluation</h3><p>Detailed evaluation unavailable.</p>').describe('A detailed evaluation formatted as an HTML string. Use headings (h3), lists (ul, li), and bold text (strong) to structure the analysis of strengths, weaknesses, and overall fit. Do not include script tags or event handlers.'),
    recommendation: z.enum(['strong_interview', 'interview', 'review', 'reject']).default('review').describe('The recommended recruiting action.'),
    scoreBreakdown: z.object({
        skillsMatch: z.coerce.number().min(1).max(10).default(5),
        experienceMatch: z.coerce.number().min(1).max(10).default(5),
        domainMatch: z.coerce.number().min(1).max(10).default(5),
        communication: z.coerce.number().min(1).max(10).default(5),
        overallReasoning: z.coerce.number().min(1).max(10).default(5),
    }).default({
        skillsMatch: 5,
        experienceMatch: 5,
        domainMatch: 5,
        communication: 5,
        overallReasoning: 5,
    }),
    strengths: z.array(z.string()).default(['Strengths were not provided in the model response.']),
    concerns: z.array(z.string()).default(['Concerns were not provided in the model response.']),
    authenticityRisk: z.enum(['low', 'moderate', 'high']).default('moderate').describe('A cautious authenticity or inconsistency risk indicator based only on evidence in the resume.'),
    authenticitySignals: z.array(z.string()).default([
        'No specific authenticity signals were provided in the model response.',
    ]).describe('Concrete signals that may require recruiter verification, such as date inconsistencies or generic achievement language.'),
    interviewQuestions: z.array(z.string()).default([
        'Which past project best matches the requirements of this role, and why?',
        'What scope of ownership did the candidate have in their most relevant experience?',
        'Which technical or domain gap would you probe first in an interview?',
    ]),
    nextStepSuggestion: z.string().default('Recruiter review recommended before making a final decision.').describe('One concrete next step for the recruiter.'),
    linkedinUrl: z.string().url().optional().or(z.literal('')).default('').describe('Full LinkedIn profile URL if found in the resume; otherwise empty string. If only a hyperlinked LinkedIn label is visible, still try to resolve the underlying URL.'),
    linkedinDetected: z.boolean().default(false).describe('True if LinkedIn is present in the resume, even if the underlying URL could not be extracted cleanly.'),
    githubUrl: z.string().url().optional().or(z.literal('')).default('').describe('Full GitHub profile or portfolio repository URL if found in the resume; otherwise empty string. If only a hyperlinked GitHub label is visible, still try to resolve the underlying URL.'),
    githubDetected: z.boolean().default(false).describe('True if GitHub is present in the resume, even if the underlying URL could not be extracted cleanly.'),
});

type EvaluationResponse = z.infer<typeof EvaluationResponseSchema>;

const SocialLinksResponseSchema = z.object({
    linkedinUrl: z.string().url().optional().or(z.literal('')).default(''),
    linkedinDetected: z.boolean().default(false),
    githubUrl: z.string().url().optional().or(z.literal('')).default(''),
    githubDetected: z.boolean().default(false),
});

function normalizeEvaluationResponse(payload: Record<string, unknown>): EvaluationResponse {
    const fallbackScore =
        typeof payload.score === 'number'
            ? payload.score
            : typeof payload.score === 'string'
                ? Number(payload.score)
                : 5;

    const breakdown =
        payload.scoreBreakdown && typeof payload.scoreBreakdown === 'object'
            ? payload.scoreBreakdown as Record<string, unknown>
            : {};

    const normalized = {
        score: Number.isFinite(fallbackScore) ? Math.min(10, Math.max(1, fallbackScore)) : 5,
        evaluationSummary:
            typeof payload.evaluationSummary === 'string' && payload.evaluationSummary.trim()
                ? payload.evaluationSummary
                : 'Evaluation summary unavailable.',
        fullEvaluation:
            typeof payload.fullEvaluation === 'string' && payload.fullEvaluation.trim()
                ? payload.fullEvaluation
                : '<h3>Evaluation</h3><p>Detailed evaluation unavailable.</p>',
        recommendation:
            typeof payload.recommendation === 'string' &&
            ['strong_interview', 'interview', 'review', 'reject'].includes(payload.recommendation)
                ? payload.recommendation
                : 'review',
        scoreBreakdown: {
            skillsMatch: Number(breakdown.skillsMatch ?? payload.score ?? 5),
            experienceMatch: Number(breakdown.experienceMatch ?? payload.score ?? 5),
            domainMatch: Number(breakdown.domainMatch ?? payload.score ?? 5),
            communication: Number(breakdown.communication ?? payload.score ?? 5),
            overallReasoning: Number(breakdown.overallReasoning ?? payload.score ?? 5),
        },
        strengths:
            Array.isArray(payload.strengths) && payload.strengths.length > 0
                ? payload.strengths.filter((item): item is string => typeof item === 'string')
                : ['Strengths were not provided in the model response.'],
        concerns:
            Array.isArray(payload.concerns) && payload.concerns.length > 0
                ? payload.concerns.filter((item): item is string => typeof item === 'string')
                : ['Concerns were not provided in the model response.'],
        authenticityRisk:
            typeof payload.authenticityRisk === 'string' &&
            ['low', 'moderate', 'high'].includes(payload.authenticityRisk)
                ? payload.authenticityRisk
                : 'moderate',
        authenticitySignals:
            Array.isArray(payload.authenticitySignals) && payload.authenticitySignals.length > 0
                ? payload.authenticitySignals.filter((item): item is string => typeof item === 'string')
                : ['No specific authenticity signals were provided in the model response.'],
        interviewQuestions:
            Array.isArray(payload.interviewQuestions) && payload.interviewQuestions.length > 0
                ? payload.interviewQuestions.filter((item): item is string => typeof item === 'string')
                : [
                    'Which past project best matches the requirements of this role, and why?',
                    'What scope of ownership did the candidate have in their most relevant experience?',
                    'Which technical or domain gap would you probe first in an interview?',
                ],
        nextStepSuggestion:
            typeof payload.nextStepSuggestion === 'string' && payload.nextStepSuggestion.trim()
                ? payload.nextStepSuggestion
                : 'Recruiter review recommended before making a final decision.',
        linkedinUrl:
            typeof payload.linkedinUrl === 'string' && payload.linkedinUrl.trim()
                ? payload.linkedinUrl.trim()
                : '',
        linkedinDetected:
            Boolean(
                payload.linkedinDetected ||
                (typeof payload.linkedinUrl === 'string' && payload.linkedinUrl.trim())
            ),
        githubUrl:
            typeof payload.githubUrl === 'string' && payload.githubUrl.trim()
                ? payload.githubUrl.trim()
                : '',
        githubDetected:
            Boolean(
                payload.githubDetected ||
                (typeof payload.githubUrl === 'string' && payload.githubUrl.trim())
            ),
    };

    return EvaluationResponseSchema.parse(normalized);
}

async function getResumeBufferFromUrl(url: string): Promise<{
    success: boolean;
    error?: string;
    buffer?: Buffer;
}> {
    if (!url || !(url.startsWith('http://') || url.startsWith('https://'))) {
        return { success: false, error: 'Invalid URL provided.' };
    }
    try {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Failed to fetch file: ${response.statusText}`);
        }
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        return { success: true, buffer };
    } catch (error) {
        console.error("Error fetching resume content:", error);
        const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred.';
        return { success: false, error: errorMessage };
    }
}

async function uploadFileToOpenAI(apiKey: string, fileBuffer: Buffer, fileName: string): Promise<{success: boolean; fileId?: string; error?: string}> {
    const formData = new FormData();
    formData.append('purpose', 'assistants');
    
    const fileBlob = new Blob([new Uint8Array(fileBuffer)], { type: 'application/octet-stream' });
    formData.append('file', fileBlob, fileName);

    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('Request timed out after 1 minute.')), 60000));
    
    try {
        const response = await Promise.race([
            fetch(`${OPENAI_API_URL}/files`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                },
                body: formData,
            }),
            timeout
        ]) as Response;

        if (!response.ok) {
            const errorData = await response.json();
            console.error('OpenAI File Upload Error:', errorData);
            return { success: false, error: errorData.error?.message || `API request failed with status ${response.status}` };
        }
        const data = await response.json();
        return { success: true, fileId: data.id };
    } catch(error) {
         if (error instanceof Error) {
            console.error('Error uploading file to OpenAI:', error.message);
            return { success: false, error: error.message };
        }
        return { success: false, error: 'An unknown error occurred during file upload.' };
    }
}

function sanitizeHtml(html: string) {
    const dom = new JSDOM(`<div id="root">${html}</div>`);
    const root = dom.window.document.getElementById('root');

    if (!root) {
        return html;
    }

    const allowedTags = new Set([
        'DIV', 'P', 'UL', 'OL', 'LI', 'STRONG', 'EM', 'B', 'I', 'H2', 'H3', 'H4',
        'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'BR', 'SPAN'
    ]);

    const walker = dom.window.document.createTreeWalker(root, dom.window.NodeFilter.SHOW_ELEMENT);
    const nodesToRemove: Element[] = [];

    while (walker.nextNode()) {
        const node = walker.currentNode as Element;
        if (!allowedTags.has(node.tagName)) {
            nodesToRemove.push(node);
            continue;
        }

        [...node.attributes].forEach((attr) => {
            const name = attr.name.toLowerCase();
            if (name.startsWith('on') || name === 'style' || name === 'srcdoc') {
                node.removeAttribute(attr.name);
            }
        });
    }

    nodesToRemove.forEach((node) => {
        const parent = node.parentNode;
        while (node.firstChild) {
            parent?.insertBefore(node.firstChild, node);
        }
        parent?.removeChild(node);
    });

    return root.innerHTML;
}

async function detectSocialLinksFromResume(
    apiKey: string,
    fileId: string,
): Promise<z.infer<typeof SocialLinksResponseSchema> | null> {
    let assistantId: string | null = null;
    let threadId: string | null = null;

    try {
        const assistantRes = await apiRequest(apiKey, '/assistants', {
            method: 'POST',
            body: JSON.stringify({
                model: 'gpt-4o',
                instructions: `You inspect resumes for contact and profile links.

Return valid JSON only with this exact shape:
{
  "linkedinUrl": "",
  "linkedinDetected": false,
  "githubUrl": "",
  "githubDetected": false
}

Rules:
- Try to recover LinkedIn and GitHub from both visible text and hyperlinked labels like "LinkedIn" or "GitHub".
- If a profile is clearly present but the exact URL cannot be cleanly extracted, set the corresponding Detected field to true and leave the URL empty.
- Never invent URLs.`,
                tools: [{ type: 'file_search' }],
                response_format: { type: 'json_object' }
            }),
        });

        if (!assistantRes.ok) {
            return null;
        }

        const assistant = await assistantRes.json();
        assistantId = assistant.id;

        const threadRes = await apiRequest(apiKey, '/threads', {
            method: 'POST',
            body: JSON.stringify({
                messages: [
                    {
                        role: "user",
                        content: "Find LinkedIn and GitHub links in the attached resume file. Pay special attention to scanned resumes and hyperlinked words.",
                        attachments: [
                            { file_id: fileId, tools: [{ type: "file_search" }] }
                        ]
                    }
                ]
            })
        });

        if (!threadRes.ok) {
            return null;
        }

        const thread = await threadRes.json();
        threadId = thread.id;

        let runRes = await apiRequest(apiKey, `/threads/${threadId}/runs`, {
            method: 'POST',
            body: JSON.stringify({ assistant_id: assistantId }),
        });

        if (!runRes.ok) {
            return null;
        }

        let run = await runRes.json();
        const startTime = Date.now();

        while (['queued', 'in_progress'].includes(run.status)) {
            if (Date.now() - startTime > 60000) {
                return null;
            }
            await new Promise((resolve) => setTimeout(resolve, 1000));
            const pollRes = await apiRequest(apiKey, `/threads/${threadId}/runs/${run.id}`, { method: 'GET' });
            if (!pollRes.ok) {
                return null;
            }
            run = await pollRes.json();
        }

        if (run.status !== 'completed') {
            return null;
        }

        const messagesRes = await apiRequest(apiKey, `/threads/${threadId}/messages`, { method: 'GET' });
        if (!messagesRes.ok) {
            return null;
        }

        const messages = await messagesRes.json();
        const assistantMessage = messages.data.find((m: any) => m.role === 'assistant');
        const textContent = assistantMessage?.content?.[0]?.text?.value;

        if (!textContent) {
            return null;
        }

        let text = textContent.trim();
        if (text.startsWith("```")) {
            text = text.replace(/^```(?:json)?\n?/, "").replace(/```$/, "").trim();
        }
        if (text.toLowerCase().startsWith("json")) {
            text = text.slice(4).trim();
        }

        const parsed = SocialLinksResponseSchema.safeParse(JSON.parse(text));
        return parsed.success ? parsed.data : null;
    } catch {
        return null;
    } finally {
        if (assistantId) {
            try {
                await apiRequest(apiKey, `/assistants/${assistantId}`, { method: 'DELETE' });
            } catch {}
        }
        if (threadId) {
            try {
                await apiRequest(apiKey, `/threads/${threadId}`, { method: 'DELETE' });
            } catch {}
        }
    }
}

async function deleteFileFromOpenAI(apiKey: string, fileId: string): Promise<void> {
    try {
        const response = await fetch(`${OPENAI_API_URL}/files/${fileId}`, {
            method: 'DELETE',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
            },
        });
        if (!response.ok) {
             const errorData = await response.json();
             console.error(`Failed to delete file ${fileId}:`, errorData.error?.message);
        }
    } catch (error) {
        if (error instanceof Error) {
            console.error(`Error deleting file ${fileId} from OpenAI:`, error.message);
        }
    }
}

async function apiRequest(
    apiKey: string,
    endpoint: string,
    options: RequestInit,
    timeoutMs: number = 60000
): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    
    const response = await fetch(`${OPENAI_API_URL}${endpoint}`, {
        ...options,
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
            'OpenAI-Beta': 'assistants=v2',
            ...options.headers,
        },
        signal: controller.signal,
    });
    
    clearTimeout(timeout);
    return response;
}

export async function validateOpenAIApiKey(apiKey?: string): Promise<{ success: boolean; error?: string }> {
    const resolvedApiKey = resolveOpenAIApiKey(apiKey);

    if (!resolvedApiKey) {
        return { success: false, error: 'OpenAI API key is missing.' };
    }

    try {
        const response = await fetch(`${OPENAI_API_URL}/models`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${resolvedApiKey}`,
            },
        });

        if (!response.ok) {
            const errorData = await response.json();
            return {
                success: false,
                error: errorData.error?.message || `Validation failed with status ${response.status}`,
            };
        }

        return { success: true };
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Validation failed.',
        };
    }
}

const CandidateSearchRequestSchema = z.object({
    apiKey: z.string().min(1, 'OpenAI API Key is required.'),
    query: z.string().min(3, 'Search query must be at least 3 characters.'),
    candidates: z.array(z.object({
        applicationId: z.number(),
        candidateName: z.string(),
        stageName: z.string().optional(),
        sourceName: z.string().optional(),
        score: z.number().nullable().optional(),
        recommendation: z.string().nullable().optional(),
        evaluationSummary: z.string().optional(),
        strengths: z.array(z.string()).optional(),
        concerns: z.array(z.string()).optional(),
        authenticityRisk: z.string().optional(),
        authenticitySignals: z.array(z.string()).optional(),
    })).min(1, 'At least one candidate is required.'),
    aiContext: z.string().optional(),
    liveJobDescription: z.string().optional(),
});

const CandidateSearchResponseSchema = z.object({
    summary: z.string().default('No summary returned.'),
    matches: z.array(z.object({
        applicationId: z.number(),
        candidateName: z.string(),
        rationale: z.string(),
    })).default([]),
});

export async function runCandidateSearchCopilot(
    apiKey: string,
    query: string,
    candidates: Array<{
        applicationId: number;
        candidateName: string;
        stageName?: string;
        sourceName?: string;
        score?: number | null;
        recommendation?: string | null;
        evaluationSummary?: string;
        strengths?: string[];
        concerns?: string[];
        authenticityRisk?: string;
        authenticitySignals?: string[];
    }>,
    aiContext?: string,
    liveJobDescription?: string,
): Promise<{ success: boolean; summary?: string; matches?: CandidateSearchMatch[]; error?: string }> {
    const resolvedApiKey = resolveOpenAIApiKey(apiKey);
    const validation = CandidateSearchRequestSchema.safeParse({
        apiKey: resolvedApiKey,
        query,
        candidates,
        aiContext,
        liveJobDescription,
    });

    if (!validation.success) {
        return { success: false, error: validation.error.errors.map((item) => item.message).join(', ') };
    }

    const candidatePayload = validation.data.candidates.map((candidate) => ({
        applicationId: candidate.applicationId,
        candidateName: candidate.candidateName,
        stageName: candidate.stageName || 'Unknown stage',
        sourceName: candidate.sourceName || 'Unknown source',
        score: candidate.score ?? null,
        recommendation: candidate.recommendation || 'not_scored',
        evaluationSummary: candidate.evaluationSummary || '',
        strengths: candidate.strengths || [],
        concerns: candidate.concerns || [],
        authenticityRisk: candidate.authenticityRisk || 'unknown',
        authenticitySignals: candidate.authenticitySignals || [],
    }));

    const prompt = `
You are an expert recruiting copilot. Use the candidate screening data below to answer a recruiter's natural-language search.

Recruiter query:
${validation.data.query}

Primary job context:
${validation.data.aiContext || 'Not provided.'}

Official job description:
${validation.data.liveJobDescription || 'Not provided.'}

Candidates:
${JSON.stringify(candidatePayload)}

Respond with valid JSON only.
Required shape:
{
  "summary": "Short recruiter-facing answer.",
  "matches": [
    {
      "applicationId": 123,
      "candidateName": "Candidate Name",
      "rationale": "Why this candidate matches the query."
    }
  ]
}

Rules:
- Return 0 to 6 matches max.
- Prefer evidence from the candidate summaries, strengths, concerns, score, and authenticity signals.
- If the recruiter asks for "missing one requirement", include candidates who look strong overall but have one clear gap.
- Do not invent facts not supported by the provided data.
`;

    try {
        const response = await fetch(`${OPENAI_API_URL}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${resolvedApiKey}`,
            },
            body: JSON.stringify({
                model: 'gpt-4o-mini',
                response_format: { type: 'json_object' },
                messages: [
                    { role: 'system', content: 'You are a precise recruiting search copilot.' },
                    { role: 'user', content: prompt },
                ],
                temperature: 0.2,
            }),
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            return { success: false, error: errorData.error?.message || `AI search failed with status ${response.status}` };
        }

        const data = await response.json();
        const content = data.choices?.[0]?.message?.content;
        if (!content) {
            return { success: false, error: 'AI search returned no content.' };
        }

        const parsed = CandidateSearchResponseSchema.safeParse(JSON.parse(content));
        if (!parsed.success) {
            return { success: false, error: 'AI search returned an invalid response.' };
        }

        return {
            success: true,
            summary: parsed.data.summary,
            matches: parsed.data.matches,
        };
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'AI search failed.',
        };
    }
}

export async function evaluateResumeWithOpenAI(
    apiKey: string,
    resumeSource: string | Buffer,
    fileName: string,
    aiContext: string,
    liveJobDescription?: string,
): Promise<{ success: boolean; evaluation?: EvaluationResponse; error?: string }> {
    const resolvedApiKey = resolveOpenAIApiKey(apiKey);

    const validation = EvaluateResumeSchema.safeParse({ apiKey: resolvedApiKey, resumeUrl: typeof resumeSource === 'string' ? resumeSource : undefined, resumeBuffer: resumeSource instanceof Buffer ? resumeSource : undefined, fileName, aiContext, liveJobDescription });
    if (!validation.success) {
        return { success: false, error: validation.error.errors.map(e => e.message).join(', ') };
    }

    let buffer: Buffer;

    if (typeof resumeSource === 'string') {
        const bufferResult = await getResumeBufferFromUrl(resumeSource);
        if (!bufferResult.success || !bufferResult.buffer) {
            return { success: false, error: `Resume Download Failed: ${bufferResult.error}` };
        }
        buffer = bufferResult.buffer;
    } else {
        buffer = resumeSource;
    }


    const uploadResult = await uploadFileToOpenAI(resolvedApiKey, buffer, fileName);
    if (!uploadResult.success || !uploadResult.fileId) {
        return { success: false, error: `File Upload Failed: ${uploadResult.error}` };
    }

    const fileId = uploadResult.fileId;
    let assistantId: string | null = null;
    let threadId: string | null = null;

    try {
        const systemPrompt = `
You are an expert HR analyst. Your task is to evaluate a candidate's resume against a specific job context. The resume is provided as an attached file.

EVALUATION CONTEXT (Primary criteria):
---
${aiContext}
---
Official Job Description (for secondary context):
---
${liveJobDescription || "Not provided."}
---
RESPONSE FORMAT:
You MUST respond in a valid JSON format. Your response object should contain these keys:
1.  "score": An integer between 1 and 10, representing the overall fit score based on the provided context.
2.  "evaluationSummary": A concise, one-to-three sentence summary of the evaluation. This will be used for a CSV export.
3.  "fullEvaluation": A detailed analysis formatted as an HTML string. Use headings (<h3>), lists (<ul>, <li>), tables, and bold text (<strong>) to structure the analysis. Do not include scripts, inline styles, or event handlers.
4.  "recommendation": One of "strong_interview", "interview", "review", or "reject".
5.  "scoreBreakdown": An object with integer scores from 1 to 10 for "skillsMatch", "experienceMatch", "domainMatch", "communication", and "overallReasoning".
6.  "strengths": An array of 1 to 5 specific strengths.
7.  "concerns": An array of 1 to 5 specific gaps or risks.
8.  "authenticityRisk": One of "low", "moderate", or "high". Use cautious recruiter-safe language and never accuse the candidate of fraud.
9.  "authenticitySignals": An array of 1 to 4 concrete verification signals, such as timeline inconsistencies, vague achievement language, suspiciously dense skill lists, or low evidence for major claims.
10. "interviewQuestions": An array of 3 to 6 targeted interview questions based on the resume and role.
11. "nextStepSuggestion": A single concrete next step for the recruiter.
12. "linkedinUrl": The full LinkedIn URL if the resume includes one. If the resume shows a hyperlinked label like "LinkedIn", inspect the attachment and try to recover the underlying URL. Otherwise return an empty string.
13. "linkedinDetected": true if the resume appears to include LinkedIn in any form, even if a clean URL could not be recovered.
14. "githubUrl": The full GitHub URL if the resume includes one. If the resume shows a hyperlinked label like "GitHub", inspect the attachment and try to recover the underlying URL. Otherwise return an empty string.
15. "githubDetected": true if the resume appears to include GitHub in any form, even if a clean URL could not be recovered.
`;

        const assistantRes = await apiRequest(resolvedApiKey, '/assistants', {
            method: 'POST',
            body: JSON.stringify({
                model: 'gpt-4o',
                instructions: systemPrompt,
                tools: [{ type: 'file_search' }],
                response_format: { type: 'json_object' }
            }),
        });
        if (!assistantRes.ok) {
            const error = await assistantRes.json();
            throw new Error(`Failed to create assistant: ${error.error?.message}`);
        }
        const assistant = await assistantRes.json();
        assistantId = assistant.id;

        const threadRes = await apiRequest(resolvedApiKey, '/threads', {
            method: 'POST',
            body: JSON.stringify({
                 messages: [
                    {
                        role: "user",
                        content: "Please analyze the attached resume file and evaluate it based on the instructions provided. Respond with only a valid JSON object.",
                        attachments: [
                            { file_id: fileId, tools: [{ type: "file_search" }] }
                        ]
                    }
                ]
            })
        });
        if (!threadRes.ok) {
            const error = await threadRes.json();
            throw new Error(`Failed to create thread: ${error.error?.message}`);
        }
        const thread = await threadRes.json();
        threadId = thread.id;

        let runRes = await apiRequest(resolvedApiKey, `/threads/${threadId}/runs`, {
            method: 'POST',
            body: JSON.stringify({ assistant_id: assistantId }),
        });
        if (!runRes.ok) {
            const error = await runRes.json();
            throw new Error(`Failed to run assistant: ${error.error?.message}`);
        }
        let run = await runRes.json();

        const startTime = Date.now();
        while (['queued', 'in_progress'].includes(run.status)) {
            if (Date.now() - startTime > 120000) { // 2 minute timeout for the run
                throw new Error('Run timed out after 2 minutes.');
            }
            await new Promise(resolve => setTimeout(resolve, 1000));
            const pollRes = await apiRequest(resolvedApiKey, `/threads/${threadId}/runs/${run.id}`, { method: 'GET' });
             if (!pollRes.ok) {
                const error = await pollRes.json();
                throw new Error(`Failed to poll run status: ${error.error?.message}`);
            }
            run = await pollRes.json();
        }

        if (run.status !== 'completed') {
            const errorDetails = run.last_error ? run.last_error.message : 'Unknown run failure.';
            throw new Error(`Run finished with status ${run.status}: ${errorDetails}`);
        }

        const messagesRes = await apiRequest(resolvedApiKey, `/threads/${threadId}/messages`, { method: 'GET' });
         if (!messagesRes.ok) {
            const error = await messagesRes.json();
            throw new Error(`Failed to retrieve messages: ${error.error?.message}`);
        }
        const messages = await messagesRes.json();

        const assistantMessage = messages.data.find((m: any) => m.role === 'assistant');
        
        if (assistantMessage && assistantMessage.content[0]?.type === 'text') {
            const textContent = assistantMessage.content[0].text.value;
            try {
                let text = textContent.trim();

                if (text.startsWith("```")) {
                text = text.replace(/^```(?:json)?\n?/, "").replace(/```$/, "").trim();
                }

                if (text.toLowerCase().startsWith("json")) {
                text = text.slice(4).trim();
                }

                const jsonContent = JSON.parse(text);
                const parsedResponse = EvaluationResponseSchema.safeParse(jsonContent);

                if (parsedResponse.success) {
                    let evaluation = parsedResponse.data;
                    if (!evaluation.linkedinUrl && !evaluation.githubUrl && !evaluation.linkedinDetected && !evaluation.githubDetected) {
                        const socialLinks = await detectSocialLinksFromResume(resolvedApiKey, fileId);
                        if (socialLinks) {
                            evaluation = {
                                ...evaluation,
                                linkedinUrl: socialLinks.linkedinUrl || evaluation.linkedinUrl,
                                linkedinDetected: socialLinks.linkedinDetected || evaluation.linkedinDetected,
                                githubUrl: socialLinks.githubUrl || evaluation.githubUrl,
                                githubDetected: socialLinks.githubDetected || evaluation.githubDetected,
                            };
                        }
                    }
                    return {
                        success: true,
                        evaluation: {
                            ...evaluation,
                            fullEvaluation: sanitizeHtml(evaluation.fullEvaluation),
                        },
                    };
                } else {
                    try {
                        let normalizedResponse = normalizeEvaluationResponse(jsonContent);
                        if (!normalizedResponse.linkedinUrl && !normalizedResponse.githubUrl && !normalizedResponse.linkedinDetected && !normalizedResponse.githubDetected) {
                            const socialLinks = await detectSocialLinksFromResume(resolvedApiKey, fileId);
                            if (socialLinks) {
                                normalizedResponse = {
                                    ...normalizedResponse,
                                    linkedinUrl: socialLinks.linkedinUrl || normalizedResponse.linkedinUrl,
                                    linkedinDetected: socialLinks.linkedinDetected || normalizedResponse.linkedinDetected,
                                    githubUrl: socialLinks.githubUrl || normalizedResponse.githubUrl,
                                    githubDetected: socialLinks.githubDetected || normalizedResponse.githubDetected,
                                };
                            }
                        }
                        return {
                            success: true,
                            evaluation: {
                                ...normalizedResponse,
                                fullEvaluation: sanitizeHtml(normalizedResponse.fullEvaluation),
                            },
                        };
                    } catch (normalizationError) {
                        console.error("Invalid JSON format from OpenAI API:", parsedResponse.error);
                        const fallbackError = normalizationError instanceof Error ? normalizationError.message : 'Unknown normalization error.';
                        return { success: false, error: `Invalid JSON format from API: ${parsedResponse.error.errors.map(e => e.message).join(', ')}. ${fallbackError}` };
                    }
                }
            } catch (e) {
                console.error("Failed to parse OpenAI JSON response:", e);
                return { success: false, error: 'Failed to parse evaluation from API.' };
            }
        } else {
            return { success: false, error: 'No evaluation returned from API.' };
        }

    } catch (error) {
        console.error('Error in Assistants API flow:', error);
        if (error instanceof Error) {
            return { success: false, error: error.message };
        }
        return { success: false, error: 'An unknown error occurred while contacting the OpenAI API.' };
    } finally {

        if (assistantId) {
            try {
                await apiRequest(resolvedApiKey, `/assistants/${assistantId}`, { method: 'DELETE' });
            } catch (e) {
                console.error(`Failed to delete assistant ${assistantId}:`, e);
            }
        }
        if (threadId) {
            try {
                await apiRequest(resolvedApiKey, `/threads/${threadId}`, { method: 'DELETE' });
            } catch (e) {
                console.error(`Failed to delete thread ${threadId}:`, e);
            }
        }
        
        await deleteFileFromOpenAI(resolvedApiKey, fileId);
    }
}
