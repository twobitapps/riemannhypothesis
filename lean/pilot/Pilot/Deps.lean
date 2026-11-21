import Lean
/-!
`#unit_deps target stop₁ stop₂ …` prints the axioms `target` depends on and which of the
`stop` constants (locked skeleton statements owned by other units) its proof actually uses.
Used for re-verification and reporting, never by submissions.
-/
open Lean Elab Command

namespace Pilot.Deps

partial def collect (stop : NameSet) (c : Name) :
    StateT (NameSet × Array Name × Array Name) CoreM Unit := do
  let (seen, _, _) ← get
  if seen.contains c then return
  modify fun (s, a, u) => (s.insert c, a, u)
  if stop.contains c then
    modify fun (s, a, u) => (s, a, u.push c)
    return
  match (← getEnv).find? c with
  | some (.axiomInfo _) => modify fun (s, a, u) => (s, a.push c, u)
  | some info => for d in info.getUsedConstantsAsSet do collect stop d
  | none => pure ()

elab "#unit_deps " t:ident stops:ident* : command => do
  let target ← liftCoreM <| realizeGlobalConstNoOverloadWithInfo t
  let mut stop : NameSet := {}
  for s in stops do
    if (← getEnv).contains s.getId then stop := stop.insert s.getId
  let ((), (_, axs, uses)) ← liftCoreM <| (collect stop target).run ({}, #[], #[])
  logInfo m!"UNIT_AXIOMS {target}: {axs.toList}"
  logInfo m!"UNIT_USES {target}: {uses.toList}"

end Pilot.Deps
