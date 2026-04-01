import {
    useState, useEffect, useMemo, useCallback, useRef, type ReactNode,
} from "react";
import { FixedSizeBinary } from "polkadot-api";
import {
    ACCOUNTS, deriveWallet, short, publishBlob, IPFS_GATEWAY,
    useHostAccount, getSurveyContract,
    type Wallet, type HostAccount,
} from "./utils.ts";
import type { SurveyData, ResponseData, SurveyListItem, Question } from "./types.ts";

const toBytes = (hex: string) => FixedSizeBinary.fromHex(hex);

const ALICE_ORIGIN = deriveWallet(ACCOUNTS[0].mnemonic).address;

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export default function App() {
    const { hostAccounts, loading: hostLoading } = useHostAccount();

    // accountKey: "host:0", "host:1" = host accounts, "dev:0".."dev:N" = dev accounts
    const [accountKey, setAccountKey] = useState<string>("dev:0");

    // Default to first host account when available
    useEffect(() => {
        if (!hostLoading && hostAccounts.length > 0) {
            setAccountKey("host:0");
        }
    }, [hostLoading, hostAccounts]);

    const wallet = useMemo<Wallet>(() => {
        if (accountKey.startsWith("host:")) {
            const idx = parseInt(accountKey.split(":")[1]);
            const ha = hostAccounts[idx];
            if (ha) return { signer: ha.signer, address: ha.address };
        }
        const idx = parseInt(accountKey.split(":")[1]) || 0;
        return deriveWallet(ACCOUNTS[idx].mnemonic);
    }, [accountKey, hostAccounts]);

    const me = useMemo(() => {
        if (accountKey.startsWith("host:")) {
            const idx = parseInt(accountKey.split(":")[1]);
            const ha = hostAccounts[idx];
            if (ha) return ha.ethAddress;
        }
        const idx = parseInt(accountKey.split(":")[1]) || 0;
        return ACCOUNTS[idx].ethAddress;
    }, [accountKey, hostAccounts]);

    const [view, setView] = useState<
        | { page: "list" }
        | { page: "fill"; surveyId: number }
        | { page: "results"; surveyId: number }
    >({ page: "list" });

    const [refreshKey, setRefreshKey] = useState(0);
    const refresh = () => setRefreshKey(k => k + 1);

    return (
        <>
            <header>
                <h1>Surveys</h1>
                <select
                    className="account-select"
                    value={accountKey}
                    onChange={e => setAccountKey(e.target.value)}
                >
                    {hostAccounts.map((ha, i) => (
                        <option key={`host:${i}`} value={`host:${i}`}>{ha.name}</option>
                    ))}
                    {ACCOUNTS.map((a, i) => (
                        <option key={`dev:${i}`} value={`dev:${i}`}>{a.name}</option>
                    ))}
                </select>
            </header>

            {view.page !== "list" && (
                <button className="back-btn" onClick={() => setView({ page: "list" })}>
                    &larr; Back to surveys
                </button>
            )}

            {view.page === "list" && (
                <SurveyList
                    key={`${refreshKey}-${accountKey}`}
                    onFill={id => setView({ page: "fill", surveyId: id })}
                    onResults={id => setView({ page: "results", surveyId: id })}
                />
            )}

            {view.page === "fill" && (
                <FillSurvey
                    surveyId={view.surveyId}
                    wallet={wallet}
                    me={me}
                    onDone={() => { refresh(); setView({ page: "list" }); }}
                />
            )}

            {view.page === "results" && (
                <SurveyResults surveyId={view.surveyId} />
            )}

            {view.page === "list" && (
                <CreateSurvey wallet={wallet} onCreated={refresh} />
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
                const contract = await getSurveyContract();
                console.log("[SurveyList] Querying contract for survey count...");
                const countRes = await contract.query("getSurveyCount", { origin: ALICE_ORIGIN });
                console.log("[SurveyList] getSurveyCount result:", countRes);
                if (!countRes.success || cancelled) return;
                const count = Number(countRes.value.response);
                console.log("[SurveyList] Total surveys on-chain:", count);

                const items: SurveyListItem[] = [];
                for (let i = count - 1; i >= 0; i--) {
                    if (cancelled) return;
                    console.log("[SurveyList] Fetching survey #%d from contract...", i);
                    const [cidRes, creatorRes, respRes] = await Promise.all([
                        contract.query("getSurveyCid", { origin: ALICE_ORIGIN, data: { survey_id: BigInt(i) } }),
                        contract.query("getSurveyCreator", { origin: ALICE_ORIGIN, data: { survey_id: BigInt(i) } }),
                        contract.query("getResponseCount", { origin: ALICE_ORIGIN, data: { survey_id: BigInt(i) } }),
                    ]);

                    const cid = cidRes.success ? cidRes.value.response : "";
                    const creator = creatorRes.success
                        ? "0x" + [...creatorRes.value.response.asBytes()].map((b: number) => b.toString(16).padStart(2, "0")).join("")
                        : "";
                    const responseCount = respRes.success ? Number(respRes.value.response) : 0;
                    console.log("[SurveyList] Survey #%d — CID:", i, cid, "creator:", short(creator), "responses:", responseCount);

                    const item: SurveyListItem = { id: i, cid, creator, responseCount };

                    if (cid) {
                        try {
                            console.log("[SurveyList] Fetching survey data from Bulletin:", IPFS_GATEWAY + cid);
                            const resp = await fetch(IPFS_GATEWAY + cid);
                            if (resp.ok) {
                                item.data = await resp.json();
                                console.log("[SurveyList] Survey #%d loaded:", i, item.data?.title);
                            }
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

function FillSurvey({ surveyId, wallet, me, onDone }: {
    surveyId: number;
    wallet: Wallet;
    me: string;
    onDone: () => void;
}) {
    const [survey, setSurvey] = useState<SurveyData | null>(null);
    const [answers, setAnswers] = useState<number[]>([]);
    const [alreadyResponded, setAlreadyResponded] = useState(false);
    const [loading, setLoading] = useState(true);
    const [submitting, setSubmitting] = useState(false);
    const [status, setStatus] = useState("");

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const contract = await getSurveyContract();

                const hasRes = await contract.query("hasResponded", {
                    origin: ALICE_ORIGIN,
                    data: { survey_id: BigInt(surveyId), user: toBytes(me) },
                });
                if (!cancelled && hasRes.success && hasRes.value.response) {
                    setAlreadyResponded(true);
                }

                const cidRes = await contract.query("getSurveyCid", {
                    origin: ALICE_ORIGIN,
                    data: { survey_id: BigInt(surveyId) },
                });
                if (!cidRes.success || cancelled) return;

                const resp = await fetch(IPFS_GATEWAY + cidRes.value.response);
                if (!resp.ok || cancelled) return;

                const data: SurveyData = await resp.json();
                setSurvey(data);
                setAnswers(new Array(data.questions.length).fill(-1));
            } catch (err) {
                console.error("Failed to load survey:", err);
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, [surveyId, me]);

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

            setStatus("Uploading response to Bulletin...");
            const bytes = new TextEncoder().encode(JSON.stringify(responseData));
            const responseCid = await publishBlob(bytes, wallet.signer);
            console.log("[FillSurvey] Bulletin upload complete. Response CID:", responseCid);

            setStatus("Submitting response on-chain...");
            const contract = await getSurveyContract();
            const tx = contract.send("submitResponse", {
                data: { survey_id: BigInt(surveyId), response_cid: responseCid },
            });
            const txResult = await tx.signAndSubmit(wallet.signer);
            console.log("[FillSurvey] Contract tx result:", txResult);

            onDone();
        } catch (err) {
            console.error("Submit response error:", err);
            setStatus("Failed — check console");
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

            {status && <div className="status">{status}</div>}

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
                const contract = await getSurveyContract();

                const cidRes = await contract.query("getSurveyCid", {
                    origin: ALICE_ORIGIN,
                    data: { survey_id: BigInt(surveyId) },
                });
                if (!cidRes.success || cancelled) return;
                const surveyCid = cidRes.value.response;

                const resp = await fetch(IPFS_GATEWAY + surveyCid);
                if (!resp.ok || cancelled) return;
                const data: SurveyData = await resp.json();
                setSurvey(data);

                const countRes = await contract.query("getResponseCount", {
                    origin: ALICE_ORIGIN,
                    data: { survey_id: BigInt(surveyId) },
                });
                if (!countRes.success || cancelled) return;
                const count = Number(countRes.value.response);
                setTotalResponses(count);

                const t: number[][] = data.questions.map(q => new Array(q.options.length).fill(0));

                for (let i = 0; i < count; i++) {
                    if (cancelled) return;
                    const rCidRes = await contract.query("getResponseCid", {
                        origin: ALICE_ORIGIN,
                        data: { survey_id: BigInt(surveyId), index: BigInt(i) },
                    });
                    if (!rCidRes.success) continue;

                    try {
                        const rResp = await fetch(IPFS_GATEWAY + rCidRes.value.response);
                        if (!rResp.ok) continue;
                        const rData: ResponseData = await rResp.json();

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

function CreateSurvey({ wallet, onCreated }: { wallet: Wallet; onCreated: () => void }) {
    const [open, setOpen] = useState(false);
    const [title, setTitle] = useState("");
    const [description, setDescription] = useState("");
    const [questions, setQuestions] = useState<QuestionDraft[]>([
        { text: "", options: ["", ""] },
    ]);
    const [status, setStatus] = useState("");
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
        setStatus("");
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

            setStatus("Uploading survey to Bulletin...");
            const bytes = new TextEncoder().encode(JSON.stringify(surveyData));
            const cid = await publishBlob(bytes, wallet.signer);
            console.log("[CreateSurvey] Bulletin upload complete. CID:", cid);

            setStatus("Creating survey on-chain...");
            const contract = await getSurveyContract();
            const tx = contract.send("createSurvey", {
                data: { cid },
            });
            const txResult = await tx.signAndSubmit(wallet.signer);
            console.log("[CreateSurvey] Contract tx result:", txResult);

            reset();
            setOpen(false);
            onCreated();
        } catch (err) {
            console.error("Create survey error:", err);
            setStatus("Failed — check console");
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

                        {status && <div className="status">{status}</div>}

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
