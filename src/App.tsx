import { useState, useEffect } from "react";
import {
    useAccountState,
    connectAccount,
    signIn,
    initContracts,
    getContract,
    uploadToBulletin,
    fetchJsonFromBulletin,
    ensureMapping,
    short,
    withTimeout,
    type AppAccount,
} from "./utils.ts";
import type { SurveyData, ResponseData, SurveyListItem } from "./types.ts";
import cdmJson from "../cdm.json";

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export default function App() {
    const { status, account, error } = useAccountState();

    // Stage cdm.json + connect to the host on mount.
    useEffect(() => {
        initContracts(cdmJson);
        console.log("[App] Connecting account...");
        connectAccount();
    }, []);

    const [view, setView] = useState<
        | { page: "list" }
        | { page: "fill"; surveyId: number }
        | { page: "results"; surveyId: number }
    >({ page: "list" });

    const [refreshKey, setRefreshKey] = useState(0);
    const refresh = () => setRefreshKey(k => k + 1);

    if (status === "idle" || status === "connecting") {
        return <div className="spinner">Connecting to host...</div>;
    }

    return (
        <>
            <header>
                <h1>Surveys</h1>
                {status === "ready" && account ? (
                    <span className="account-select">{account.name ?? short(account.address)}</span>
                ) : (
                    <button className="btn btn-primary btn-sm" onClick={() => signIn()}>
                        {status === "error" ? "Retry sign-in" : "Sign in"}
                    </button>
                )}
            </header>

            {status === "error" && error && <div className="status">{error}</div>}

            {view.page !== "list" && (
                <button className="back-btn" onClick={() => setView({ page: "list" })}>
                    &larr; Back to surveys
                </button>
            )}

            {view.page === "list" && (
                <SurveyList
                    key={refreshKey}
                    onFill={id => setView({ page: "fill", surveyId: id })}
                    onResults={id => setView({ page: "results", surveyId: id })}
                />
            )}

            {view.page === "fill" && account && (
                <FillSurvey
                    surveyId={view.surveyId}
                    account={account}
                    onDone={() => { refresh(); setView({ page: "list" }); }}
                />
            )}

            {view.page === "results" && (
                <SurveyResults surveyId={view.surveyId} />
            )}

            {view.page === "list" && account && (
                <CreateSurvey account={account} onCreated={refresh} />
            )}
        </>
    );
}

// ---------------------------------------------------------------------------
// Survey List
// ---------------------------------------------------------------------------

function SurveyList({ onFill, onResults }: {
    onFill: (id: number) => void;
    onResults: (id: number) => void;
}) {
    const [surveys, setSurveys] = useState<SurveyListItem[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const sv = getContract();
                if (!sv) return;
                console.log("[SurveyList] Querying contract for survey count...");
                const countRes = await sv.getSurveyCount.query();
                if (!countRes.success || cancelled) return;
                const count = Number(countRes.value);
                console.log("[SurveyList] Total surveys on-chain:", count);

                const items: SurveyListItem[] = [];
                for (let i = count - 1; i >= 0; i--) {
                    if (cancelled) return;
                    const [cidRes, creatorRes, respRes] = await Promise.all([
                        sv.getSurveyCid.query(BigInt(i)),
                        sv.getSurveyCreator.query(BigInt(i)),
                        sv.getResponseCount.query(BigInt(i)),
                    ]);

                    const cid = cidRes.success ? cidRes.value : "";
                    const creator = creatorRes.success ? String(creatorRes.value) : "";
                    const responseCount = respRes.success ? Number(respRes.value) : 0;

                    const item: SurveyListItem = { id: i, cid, creator, responseCount };

                    if (cid) {
                        try {
                            item.data = await fetchJsonFromBulletin<SurveyData>(cid);
                        } catch { /* gateway might be slow */ }
                    }

                    items.push(item);
                }

                if (!cancelled) setSurveys(items);
            } catch (err) {
                console.error("Failed to load surveys:", err);
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, []);

    if (loading) return <div className="spinner">Loading surveys...</div>;
    if (surveys.length === 0) {
        return <div className="empty">No surveys yet.<br />Create the first one!</div>;
    }

    return (
        <div>
            {surveys.map(s => (
                <div key={s.id} className="survey-card">
                    <div className="survey-card-header">
                        <div className="survey-card-title">
                            {s.data?.title ?? `Survey #${s.id}`}
                        </div>
                        <div className="survey-card-meta">#{s.id}</div>
                    </div>
                    {s.data?.description && (
                        <div className="survey-card-desc">{s.data.description}</div>
                    )}
                    <div className="survey-card-footer">
                        <span className="badge">
                            {s.data?.questions.length ?? "?"} questions
                        </span>
                        <span className="badge">
                            {s.responseCount} responses
                        </span>
                        <span className="badge">by {short(s.creator)}</span>
                    </div>
                    <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                        <button className="btn btn-primary btn-sm" onClick={() => onFill(s.id)}>
                            Fill
                        </button>
                        <button className="btn btn-ghost btn-sm" onClick={() => onResults(s.id)}>
                            Results
                        </button>
                    </div>
                </div>
            ))}
        </div>
    );
}

// ---------------------------------------------------------------------------
// Fill Survey
// ---------------------------------------------------------------------------

function FillSurvey({ surveyId, account, onDone }: {
    surveyId: number;
    account: AppAccount;
    onDone: () => void;
}) {
    const [survey, setSurvey] = useState<SurveyData | null>(null);
    const [answers, setAnswers] = useState<number[]>([]);
    const [alreadyResponded, setAlreadyResponded] = useState(false);
    const [loading, setLoading] = useState(true);
    const [submitting, setSubmitting] = useState(false);
    const [statusMsg, setStatusMsg] = useState("");

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const sv = getContract();
                if (!sv) return;
                const hasRes = await sv.hasResponded.query(BigInt(surveyId), account.h160Address);
                if (!cancelled && hasRes.success && hasRes.value) {
                    setAlreadyResponded(true);
                }

                const cidRes = await sv.getSurveyCid.query(BigInt(surveyId));
                if (!cidRes.success || !cidRes.value || cancelled) return;

                const data = await fetchJsonFromBulletin<SurveyData>(cidRes.value);
                if (cancelled) return;
                setSurvey(data);
                setAnswers(new Array(data.questions.length).fill(-1));
            } catch (err) {
                console.error("Failed to load survey:", err);
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, [surveyId, account.address]);

    const selectOption = (qIdx: number, oIdx: number) => {
        setAnswers(prev => {
            const next = [...prev];
            next[qIdx] = oIdx;
            return next;
        });
    };

    const allAnswered = answers.length > 0 && answers.every(a => a >= 0);

    const submit = async () => {
        if (!allAnswered || submitting) return;
        setSubmitting(true);
        try {
            const responseData: ResponseData = {
                surveyId,
                answers,
                respondedAt: Math.floor(Date.now() / 1000),
            };
            console.log("[FillSurvey] Response data:", responseData);

            setStatusMsg("Uploading response to Bulletin...");
            const bytes = new TextEncoder().encode(JSON.stringify(responseData));
            const cid = await uploadToBulletin(bytes);
            console.log("[FillSurvey] Bulletin upload complete. CID:", cid);

            setStatusMsg("Ensuring account is mapped...");
            await ensureMapping(account);

            setStatusMsg("Submitting response on-chain (approve on your phone)...");
            await withTimeout(
                getContract().submitResponse.tx(BigInt(surveyId), cid),
                120_000,
                "submitResponse.tx",
            );
            console.log("[FillSurvey] Response submitted!");

            onDone();
        } catch (err) {
            console.error("Submit response error:", err);
            setStatusMsg(err instanceof Error ? `Failed: ${err.message}` : "Failed — check console");
        } finally {
            setSubmitting(false);
        }
    };

    if (loading) return <div className="spinner">Loading survey...</div>;
    if (!survey) return <div className="empty">Survey not found.</div>;

    if (alreadyResponded) {
        return <div className="already-responded">You have already responded to this survey.</div>;
    }

    return (
        <div className="survey-fill">
            <h2>{survey.title}</h2>
            {survey.description && <p className="survey-fill-desc">{survey.description}</p>}

            {survey.questions.map((q, qi) => (
                <div key={qi} className="question-block">
                    <div className="question-text">{qi + 1}. {q.text}</div>
                    {q.options.map((opt, oi) => (
                        <label
                            key={oi}
                            className={`option-label ${answers[qi] === oi ? "selected" : ""}`}
                            onClick={() => selectOption(qi, oi)}
                        >
                            <input type="radio" name={`q-${qi}`} checked={answers[qi] === oi} readOnly />
                            <span className="radio-dot" />
                            {opt}
                        </label>
                    ))}
                </div>
            ))}

            {statusMsg && <div className="status">{statusMsg}</div>}

            <button
                className="btn btn-primary"
                style={{ width: "100%" }}
                onClick={submit}
                disabled={!allAnswered || submitting}
            >
                {submitting ? "Submitting..." : "Submit Response"}
            </button>
        </div>
    );
}

// ---------------------------------------------------------------------------
// Survey Results
// ---------------------------------------------------------------------------

function SurveyResults({ surveyId }: { surveyId: number }) {
    const [survey, setSurvey] = useState<SurveyData | null>(null);
    const [tallies, setTallies] = useState<number[][] | null>(null);
    const [totalResponses, setTotalResponses] = useState(0);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const sv = getContract();
                if (!sv) return;
                const cidRes = await sv.getSurveyCid.query(BigInt(surveyId));
                if (!cidRes.success || !cidRes.value || cancelled) return;

                const data = await fetchJsonFromBulletin<SurveyData>(cidRes.value);
                if (cancelled) return;
                setSurvey(data);

                const countRes = await sv.getResponseCount.query(BigInt(surveyId));
                if (!countRes.success || cancelled) return;
                const count = Number(countRes.value);
                setTotalResponses(count);

                const t: number[][] = data.questions.map(q => new Array(q.options.length).fill(0));

                for (let i = 0; i < count; i++) {
                    if (cancelled) return;
                    const rCidRes = await sv.getResponseCid.query(BigInt(surveyId), BigInt(i));
                    if (!rCidRes.success || !rCidRes.value) continue;

                    try {
                        const rData = await fetchJsonFromBulletin<ResponseData>(rCidRes.value);
                        rData.answers.forEach((optIdx, qIdx) => {
                            if (qIdx < t.length && optIdx >= 0 && optIdx < t[qIdx].length) {
                                t[qIdx][optIdx]++;
                            }
                        });
                    } catch { /* skip malformed responses */ }
                }

                if (!cancelled) setTallies(t);
            } catch (err) {
                console.error("Failed to load results:", err);
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, [surveyId]);

    if (loading) return <div className="spinner">Loading results...</div>;
    if (!survey || !tallies) return <div className="empty">No results available.</div>;

    return (
        <div className="results">
            <h2>{survey.title}</h2>
            <div style={{ fontSize: 13, color: "var(--text2)", marginBottom: 16 }}>
                {totalResponses} response{totalResponses !== 1 ? "s" : ""}
            </div>

            {survey.questions.map((q, qi) => {
                const questionTotal = tallies[qi].reduce((a, b) => a + b, 0);
                return (
                    <div key={qi} className="results-question">
                        <div className="results-question-text">{qi + 1}. {q.text}</div>
                        {q.options.map((opt, oi) => {
                            const count = tallies[qi][oi];
                            const pct = questionTotal > 0 ? Math.round((count / questionTotal) * 100) : 0;
                            return (
                                <div key={oi} className="result-bar">
                                    <div className="result-label">{opt}</div>
                                    <div className="result-track">
                                        <div className="result-fill" style={{ width: `${pct}%` }} />
                                    </div>
                                    <div className="result-pct">{pct}%</div>
                                </div>
                            );
                        })}
                        <div className="result-count">{questionTotal} votes</div>
                    </div>
                );
            })}
        </div>
    );
}

// ---------------------------------------------------------------------------
// Create Survey (FAB + modal)
// ---------------------------------------------------------------------------

interface QuestionDraft {
    text: string;
    options: string[];
}

function CreateSurvey({ account, onCreated }: {
    account: AppAccount;
    onCreated: () => void;
}) {
    const [open, setOpen] = useState(false);
    const [title, setTitle] = useState("");
    const [description, setDescription] = useState("");
    const [questions, setQuestions] = useState<QuestionDraft[]>([
        { text: "", options: ["", ""] },
    ]);
    const [statusMsg, setStatusMsg] = useState("");
    const [busy, setBusy] = useState(false);

    const updateQuestion = (qi: number, text: string) => {
        setQuestions(prev => {
            const next = [...prev];
            next[qi] = { ...next[qi], text };
            return next;
        });
    };

    const updateOption = (qi: number, oi: number, value: string) => {
        setQuestions(prev => {
            const next = [...prev];
            const opts = [...next[qi].options];
            opts[oi] = value;
            next[qi] = { ...next[qi], options: opts };
            return next;
        });
    };

    const addOption = (qi: number) => {
        setQuestions(prev => {
            const next = [...prev];
            next[qi] = { ...next[qi], options: [...next[qi].options, ""] };
            return next;
        });
    };

    const removeOption = (qi: number, oi: number) => {
        setQuestions(prev => {
            const next = [...prev];
            if (next[qi].options.length <= 2) return prev;
            const opts = next[qi].options.filter((_, i) => i !== oi);
            next[qi] = { ...next[qi], options: opts };
            return next;
        });
    };

    const addQuestion = () => {
        setQuestions(prev => [...prev, { text: "", options: ["", ""] }]);
    };

    const removeQuestion = (qi: number) => {
        if (questions.length <= 1) return;
        setQuestions(prev => prev.filter((_, i) => i !== qi));
    };

    const isValid = title.trim() &&
        questions.every(q => q.text.trim() && q.options.every(o => o.trim()) && q.options.length >= 2);

    const reset = () => {
        setTitle("");
        setDescription("");
        setQuestions([{ text: "", options: ["", ""] }]);
        setStatusMsg("");
    };

    const submit = async () => {
        if (!isValid || busy) return;
        setBusy(true);
        try {
            const surveyData: SurveyData = {
                title: title.trim(),
                description: description.trim(),
                questions: questions.map(q => ({
                    text: q.text.trim(),
                    options: q.options.map(o => o.trim()),
                })),
                createdAt: Math.floor(Date.now() / 1000),
            };
            console.log("[CreateSurvey] Survey data:", surveyData);

            setStatusMsg("Uploading survey to Bulletin...");
            const bytes = new TextEncoder().encode(JSON.stringify(surveyData));
            const cid = await uploadToBulletin(bytes);
            console.log("[CreateSurvey] Bulletin upload complete. CID:", cid);

            setStatusMsg("Ensuring account is mapped...");
            await ensureMapping(account);

            setStatusMsg("Creating survey on-chain (approve on your phone)...");
            await withTimeout(
                getContract().createSurvey.tx(cid),
                120_000,
                "createSurvey.tx",
            );
            console.log("[CreateSurvey] Survey created!");

            reset();
            setOpen(false);
            onCreated();
        } catch (err) {
            console.error("Create survey error:", err);
            setStatusMsg(err instanceof Error ? `Failed: ${err.message}` : "Failed — check console");
        } finally {
            setBusy(false);
        }
    };

    return (
        <>
            <button className="fab" onClick={() => setOpen(true)}>+</button>
            {open && (
                <div className="modal-overlay" onClick={() => !busy && setOpen(false)}>
                    <div className="modal" onClick={e => e.stopPropagation()}>
                        <h2>New Survey</h2>

                        <input
                            type="text"
                            placeholder="Survey title"
                            value={title}
                            onChange={e => setTitle(e.target.value)}
                        />
                        <textarea
                            rows={2}
                            placeholder="Description (optional)"
                            value={description}
                            onChange={e => setDescription(e.target.value)}
                        />

                        {questions.map((q, qi) => (
                            <div key={qi} className="question-builder">
                                <div className="question-builder-header">
                                    <span>Question {qi + 1}</span>
                                    {questions.length > 1 && (
                                        <button
                                            className="remove-btn"
                                            onClick={() => removeQuestion(qi)}
                                        >
                                            &times;
                                        </button>
                                    )}
                                </div>
                                <input
                                    type="text"
                                    placeholder="Question text"
                                    value={q.text}
                                    onChange={e => updateQuestion(qi, e.target.value)}
                                />
                                {q.options.map((opt, oi) => (
                                    <div key={oi} className="option-row">
                                        <input
                                            type="text"
                                            placeholder={`Option ${oi + 1}`}
                                            value={opt}
                                            onChange={e => updateOption(qi, oi, e.target.value)}
                                        />
                                        {q.options.length > 2 && (
                                            <button
                                                className="remove-btn"
                                                onClick={() => removeOption(qi, oi)}
                                            >
                                                &times;
                                            </button>
                                        )}
                                    </div>
                                ))}
                                <button className="add-option-btn" onClick={() => addOption(qi)}>
                                    + Add option
                                </button>
                            </div>
                        ))}

                        <button className="add-question-btn" onClick={addQuestion}>
                            + Add question
                        </button>

                        {statusMsg && <div className="status">{statusMsg}</div>}

                        <div className="modal-actions">
                            <button
                                className="btn btn-ghost"
                                onClick={() => { reset(); setOpen(false); }}
                                disabled={busy}
                            >
                                Cancel
                            </button>
                            <button
                                className="btn btn-primary"
                                onClick={submit}
                                disabled={busy || !isValid}
                            >
                                {busy ? "Creating..." : "Create Survey"}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </>
    );
}
