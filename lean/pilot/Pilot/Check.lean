import Lean
/-!
`#unit_axioms target stop₁ stop₂ …` prints the axioms that `target` depends on, without
descending into the `stop` constants (locked skeleton statements of other units, whose proofs
are other units). Used by the pilot driver, never by submissions.
-/
open Lean Elab Command

namespace Pilot.Check

partial def collect (stop : NameSet) (c : Name) : StateT (NameSet × Array Name) CoreM Unit := do
  let (seen, _) ← get
  if seen.contains c then return
  modify fun (s, a) => (s.insert c, a)
  if stop.contains c then return
  match (← getEnv).find? c with
  | some (.axiomInfo _) => modify fun (s, a) => (s, a.push c)
  | some info => for d in info.getUsedConstantsAsSet do collect stop d
  | none => pure ()

elab "#unit_axioms " t:ident stops:ident* : command => do
  let target ← liftCoreM <| realizeGlobalConstNoOverloadWithInfo t
  let mut stop : NameSet := {}
  for s in stops do
    -- stop names that are not in this file's environment are simply ignored
    if (← getEnv).contains s.getId then stop := stop.insert s.getId
  let ((), (_, axs)) ← liftCoreM <| (collect stop target).run ({}, #[])
  logInfo m!"UNIT_AXIOMS {target}: {axs.toList}"

end Pilot.Check
