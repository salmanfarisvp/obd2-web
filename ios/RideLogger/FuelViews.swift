import SwiftUI

// MARK: - Mileage & cost card (History tab)

struct VehicleCostCard: View {
    @EnvironmentObject private var fuel: FuelStore
    let vehicle: String

    var body: some View {
        let rides = fuel.rides.filter { $0.vehicleName == vehicle }
        let mileage = fuel.mileage(for: vehicle)
        let km = rides.reduce(0) { $0 + ($1.distanceKm ?? 0) }
        let litres = rides.compactMap { fuel.fuel(for: $0) }.reduce(0, +)
        let fuelledKm = rides.filter { fuel.fuel(for: $0) != nil }.reduce(0) { $0 + ($1.distanceKm ?? 0) }
        let costed = rides.compactMap { r in fuel.cost(for: r).map { (cost: $0, km: r.distanceKm ?? 0) } }
        let cost = costed.reduce(0) { $0 + $1.cost }
        let costedKm = costed.reduce(0) { $0 + $1.km }
        let kmPerL = mileage?.kmPerL ?? (litres > 0 ? fuelledKm / litres : nil)

        VStack(alignment: .leading, spacing: 8) {
            Text(vehicle).font(.headline)
            StatGrid(items: [
                ("Distance", fmt(km, 1), "km"),
                ("Rides", "\(rides.count)", ""),
                (mileage != nil ? "Mileage (real)" : "Mileage (est.)", fmt(kmPerL, 1), "km/L"),
                ("Fuel used", fmt(litres, 2), "L"),
                ("Fuel cost", cost > 0 ? money(fuel.currency, cost) : "–", ""),
                ("Cost / km", costedKm > 0 ? money(fuel.currency, cost / costedKm) : "–", ""),
            ])
            Text(mileageNote(mileage)).font(.caption).foregroundStyle(.secondary)
        }
    }

    private func mileageNote(_ m: Mileage?) -> String {
        guard let m else {
            let priceHint = fuel.profile?.fuelPrice == nil && fuel.logs.isEmpty ? " Set your petrol price in Profile to see costs." : ""
            return "Estimated from engine data. Log fill-ups in the Fuel tab for real mileage." + priceHint
        }
        return "Real mileage from \(m.fills) fill-ups (\(fmt(m.litres, 1)) L, \(fmt(m.km)) km)"
            + (m.confident ? "." : ". Approximate until you've logged a few more fill-ups.")
    }
}

// MARK: - Fuel tab

struct FuelView: View {
    @EnvironmentObject private var fuel: FuelStore
    @EnvironmentObject private var recorder: Recorder

    @State private var vehicle = ""
    @State private var date = Date()
    @State private var price = ""
    @State private var amount = ""
    @State private var litres = ""
    @State private var fullTank = false
    @State private var note = ""
    @State private var saving = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                ForEach(fuel.vehicleNames(including: recorder.vehicle), id: \.self) { name in
                    if fuel.logs.contains(where: { $0.vehicleName == name }) || name == vehicle {
                        Section { summary(name) }
                    }
                }
                addSection
                logSection
            }
            .navigationTitle("Fuel")
            .refreshable { await fuel.load() }
            .task {
                await fuel.load()
                if vehicle.isEmpty { vehicle = recorder.vehicle }
                if price.isEmpty, let p = fuel.logs.last(where: { $0.pricePerL != nil })?.pricePerL ?? fuel.profile?.fuelPrice {
                    price = String(format: "%.2f", p)
                }
            }
        }
    }

    private func summary(_ name: String) -> some View {
        let m = fuel.mileage(for: name)
        let vLogs = fuel.logs.filter { $0.vehicleName == name }
        let spent = vLogs.compactMap(\.amount).reduce(0, +)
        return VStack(alignment: .leading, spacing: 8) {
            Text(name).font(.headline)
            StatGrid(items: [
                ("Real mileage", fmt(m?.kmPerL, 1), "km/L"),
                ("Fill-ups", "\(vLogs.count)", ""),
                ("Petrol bought", fmt(vLogs.reduce(0) { $0 + $1.litres }, 1), "L"),
                ("Spent", spent > 0 ? money(fuel.currency, spent) : "–", ""),
            ])
            Text(m.map { "\(fmt($0.km)) km on \(fmt($0.litres, 1)) L between fill-ups" + ($0.confident ? "." : ". Approximate: it gets more accurate with every fill-up.") }
                 ?? "Real mileage appears after two fill-ups with rides logged between them.")
                .font(.caption).foregroundStyle(.secondary)
        }
    }

    private var addSection: some View {
        Section("Add fill-up") {
            Picker("Vehicle", selection: $vehicle) {
                ForEach(fuel.vehicleNames(including: recorder.vehicle), id: \.self) { Text($0).tag($0) }
            }
            DatePicker("Date", selection: $date)
            LabeledContent("Price per litre (\(fuel.currency.trimmingCharacters(in: .whitespaces)))") {
                TextField("e.g. 102.50", text: $price).decimalField()
                    .onChange(of: price) { _, p in
                        if let pv = Double(p), pv > 0, let l = Double(litres), l > 0 { amount = String(format: "%.2f", l * pv) }
                    }
            }
            LabeledContent("Amount paid") {
                TextField("e.g. 200", text: Binding(get: { amount }, set: { v in
                    amount = v
                    if let a = Double(v), a > 0, let p = Double(price), p > 0 { litres = String(format: "%.2f", a / p) }
                })).decimalField()
            }
            LabeledContent("Litres") {
                TextField("e.g. 1.95", text: Binding(get: { litres }, set: { v in
                    litres = v
                    if let l = Double(v), l > 0, let p = Double(price), p > 0 { amount = String(format: "%.2f", l * p) }
                })).decimalField()
            }
            Toggle("Filled to full tank", isOn: $fullTank)
            TextField("Note (optional)", text: $note)
            Button(saving ? "Saving…" : "Add fill-up") { add() }.disabled(saving)
            if let error { Text(error).foregroundStyle(.red) }
        }
    }

    private var logSection: some View {
        Section("Fill-ups") {
            if fuel.logs.isEmpty { Text("No fill-ups yet.").foregroundStyle(.secondary) }
            ForEach(fuel.logs.reversed()) { log in
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(log.filledAt.formatted(date: .abbreviated, time: .shortened)).font(.subheadline.weight(.semibold))
                        Text([log.vehicleName,
                              log.pricePerL.map { "\(money(fuel.currency, $0))/L" },
                              log.fullTank ? "full tank" : nil,
                              log.source == "auto" ? "detected" : nil].compactMap { $0 }.joined(separator: " · "))
                            .font(.caption).foregroundStyle(.secondary)
                        if let note = log.note { Text("📝 \(note)").font(.caption) }
                    }
                    Spacer()
                    VStack(alignment: .trailing, spacing: 2) {
                        Text("\(fmt(log.litres, 2)) L").font(.subheadline.bold())
                        if let a = log.amount { Text(money(fuel.currency, a)).font(.caption).foregroundStyle(.secondary) }
                    }
                }
                .swipeActions {
                    Button("Delete", role: .destructive) {
                        Task {
                            try? await fuel.deleteFillUp(id: log.id)
                            await fuel.load()
                        }
                    }
                }
            }
        }
    }

    private func add() {
        guard let l = Double(litres), l > 0 else {
            error = "Enter the litres or the amount paid."
            return
        }
        error = nil
        saving = true
        let p = Double(price).flatMap { $0 > 0 ? $0 : nil }
        let a = Double(amount).flatMap { $0 > 0 ? $0 : nil }
        let trimmed = note.trimmingCharacters(in: .whitespaces)
        Task {
            do {
                try await fuel.addFillUp(vehicle: vehicle.isEmpty ? recorder.vehicle : vehicle, at: date, litres: l, amount: a,
                                         price: p, fullTank: fullTank, note: trimmed.isEmpty ? nil : trimmed)
                amount = ""
                litres = ""
                fullTank = false
                note = ""
                date = Date()
                await fuel.load()
            } catch {
                self.error = error.localizedDescription
            }
            saving = false
        }
    }
}

// MARK: - Profile tab

struct ProfileView: View {
    @EnvironmentObject private var fuel: FuelStore
    @EnvironmentObject private var recorder: Recorder
    @EnvironmentObject private var client: SupabaseClient

    private struct VehicleDraft: Identifiable {
        let id = UUID()
        var dbId: String?
        var name: String
        var originalName: String?
        var tank: String
    }

    @State private var currency = defaultCurrency
    @State private var price = ""
    @State private var drafts: [VehicleDraft] = []
    @State private var loaded = false
    @State private var status: String?

    private let currencies = ["₹", "$", "€", "£", "AED ", "SAR "]

    var body: some View {
        NavigationStack {
            Form {
                Section("Currency") {
                    Picker("Currency", selection: $currency) {
                        ForEach(currencies + (currencies.contains(currency) ? [] : [currency]), id: \.self) {
                            Text($0.trimmingCharacters(in: .whitespaces)).tag($0)
                        }
                    }
                    .pickerStyle(.segmented)
                    LabeledContent("Custom symbol") {
                        TextField("₹", text: $currency).multilineTextAlignment(.trailing)
                    }
                }
                Section {
                    LabeledContent("Petrol price per litre") {
                        TextField("e.g. 102.50", text: $price).decimalField()
                    }
                } footer: {
                    Text("Used for ride costs until you log a fill-up; each fill-up then sets the price.")
                }
                Section("Vehicles") {
                    ForEach($drafts) { $d in
                        VStack(alignment: .leading) {
                            TextField("Name", text: $d.name)
                            LabeledContent("Tank capacity (L)") {
                                TextField("e.g. 5.3", text: $d.tank).decimalField()
                            }
                        }
                        .swipeActions {
                            Button("Remove", role: .destructive) { remove(d) }
                        }
                    }
                    Button("+ Add vehicle") { drafts.append(VehicleDraft(name: "", tank: "")) }
                }
                Section {
                    Button("Save profile") { save() }
                    if let status { Text(status).foregroundStyle(.secondary) }
                }
                Section("Account") {
                    Text(client.session?.email ?? "").foregroundStyle(.secondary)
                    Button("Sign out", role: .destructive) { client.signOut() }
                }
            }
            .navigationTitle("Profile")
            .task {
                guard !loaded else { return }
                await fuel.load()
                currency = fuel.profile?.currency ?? defaultCurrency
                price = fuel.profile?.fuelPrice.map { String(format: "%.2f", $0) } ?? ""
                if fuel.vehicles.isEmpty {
                    // Suggest the vehicles already used for rides.
                    drafts = fuel.vehicleNames(including: recorder.vehicle).map {
                        VehicleDraft(name: $0, tank: $0 == "Suzuki Access 125" ? "5.3" : "")
                    }
                } else {
                    drafts = fuel.vehicles.map { VehicleDraft(dbId: $0.id, name: $0.name, originalName: $0.name, tank: $0.tankL.map { fmt($0, 1) } ?? "") }
                }
                loaded = true
            }
        }
    }

    private func save() {
        let p = price.trimmingCharacters(in: .whitespaces)
        guard p.isEmpty || (Double(p) ?? 0) > 0 else {
            status = "Enter a valid petrol price."
            return
        }
        status = "Saving…"
        Task {
            do {
                try await fuel.saveProfile(currency: currency.isEmpty ? defaultCurrency : currency, fuelPrice: Double(p))
                for d in drafts {
                    let name = d.name.trimmingCharacters(in: .whitespaces)
                    guard !name.isEmpty else { continue }
                    try await fuel.saveVehicle(id: d.dbId, name: name, tankL: Double(d.tank), originalName: d.originalName)
                    if let old = d.originalName, old != name, recorder.vehicle == old { recorder.vehicle = name }
                }
                await fuel.load()
                drafts = fuel.vehicles.map { VehicleDraft(dbId: $0.id, name: $0.name, originalName: $0.name, tank: $0.tankL.map { fmt($0, 1) } ?? "") }
                status = "Saved"
            } catch {
                status = "Couldn't save: \(error.localizedDescription)"
            }
        }
    }

    private func remove(_ d: VehicleDraft) {
        drafts.removeAll { $0.id == d.id }
        guard let id = d.dbId else { return }
        Task {
            try? await fuel.deleteVehicle(id: id)
            await fuel.load()
        }
    }
}

private extension View {
    func decimalField() -> some View {
        keyboardType(.decimalPad).multilineTextAlignment(.trailing)
    }
}
