// approval-queue.js — Inline approval card queue (canonical copy).
// Each approval gets its own card; parallel tool calls never clobber.
export function createApprovalQueue({ pendingApprovals, client, render }) {
  return {
    render() {
      const queue = document.getElementById('approvalQueue');
      if (!queue) return;
      queue.innerHTML = '';
      queue.classList.toggle('hidden', pendingApprovals.size === 0);
      for (const [id, req] of pendingApprovals) {
        const card = document.createElement('div');
        card.className = 'approval-card';
        card.dataset.approvalId = id;
        card.setAttribute('role', 'alertdialog');
        const title = document.createElement('div');
        title.className = 'approval-card-tool';
        title.textContent = `Tool: ${req.toolName}`;
        card.appendChild(title);
        if (req.reason) {
          const r = document.createElement('div');
          r.className = 'approval-card-reason';
          r.textContent = req.reason;
          card.appendChild(r);
        }
        const pre = document.createElement('pre');
        pre.className = 'approval-args-box';
        pre.textContent = JSON.stringify(req.args, null, 2);
        card.appendChild(pre);
        const actions = document.createElement('div');
        actions.className = 'approval-card-actions';
        for (const [label, action, cls] of [['Approve Once', 'approve_once', 'btn-primary'], ['Always Allow', 'always_allow', 'btn-secondary'], ['Reject', 'reject', 'btn-ghost']]) {
          const b = document.createElement('button');
          b.className = `btn btn-sm ${cls}`;
          b.textContent = label;
          b.onclick = async () => {
            pendingApprovals.delete(id);
            render();
            await client.approveTool(id, { action, epoch: req.epoch });
          };
          actions.appendChild(b);
        }
        card.appendChild(actions);
        queue.appendChild(card);
      }
    },
  };
}
