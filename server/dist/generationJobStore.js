export const createMemoryGenerationJobStore = () => {
    const jobs = new Map();
    return {
        createGenerationJob: (job) => { jobs.set(job.id, structuredClone(job)); },
        getGenerationJob: (id) => {
            const job = jobs.get(id);
            return job ? structuredClone(job) : null;
        },
        updateGenerationJob: (id, patch) => {
            const job = jobs.get(id);
            if (!job)
                return null;
            const next = { ...job, ...structuredClone(patch) };
            jobs.set(id, next);
            return structuredClone(next);
        },
        recoverInterruptedGenerationJobs: () => {
            let recovered = 0;
            jobs.forEach((job, id) => {
                if (job.status !== 'running')
                    return;
                jobs.set(id, { ...job, status: 'retry_pending', updatedAt: new Date().toISOString() });
                recovered += 1;
            });
            return recovered;
        },
        sweepGenerationJobs: (now, terminalBefore) => {
            let timedOut = 0;
            let deleted = 0;
            jobs.forEach((job, id) => {
                if (['queued', 'running', 'retry_pending', 'provider_pending'].includes(job.status) && job.deadlineAt <= now) {
                    jobs.set(id, {
                        ...job,
                        status: 'timeout',
                        errorMessage: '生成任务已超过设置的总等待时间',
                        updatedAt: now
                    });
                    timedOut += 1;
                    return;
                }
                if (['completed', 'failed', 'timeout'].includes(job.status) && job.updatedAt < terminalBefore) {
                    jobs.delete(id);
                    deleted += 1;
                }
            });
            return { timedOut, deleted };
        }
    };
};
