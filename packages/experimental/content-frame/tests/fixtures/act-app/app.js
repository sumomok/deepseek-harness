// The handlers a set of steps is meant to reach: the button really changes the
// document, and the message it shows goes away on its own, which is what a
// call's second section is written against.
const name = document.getElementById('machine-name')
const site = document.getElementById('machine-site')
const count = document.getElementById('added-count')
const rows = document.getElementById('fleet-rows')
const toast = document.getElementById('toast')

document.getElementById('add-machine').addEventListener('click', () => {
  const added = Number(count.dataset.added ?? '0') + 1
  count.dataset.added = String(added)
  count.textContent = `Machines added: ${added}`
  const row = document.createElement('tr')
  const machine = document.createElement('td')
  machine.textContent = name.value
  const where = document.createElement('td')
  where.textContent = site.options[site.selectedIndex].text
  row.append(machine, where)
  rows.append(row)
  toast.textContent = `Added ${name.value}`
  toast.hidden = false
  setTimeout(() => {
    toast.hidden = true
    toast.textContent = ''
  }, 400)
})

// Records that this document executed, so a spec can tell a live frame from a
// reloaded one: the counter restarts at 1 on every navigation of the frame.
window.__contentAppLoads = (window.__contentAppLoads ?? 0) + 1
