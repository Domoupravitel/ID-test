/* Browser Firestore adapter. Reads retain the public SDK contract. Mutations
 * accept only opaque authorities issued for the single trusted app binding. */
function installFirestoreClient(sdk, binding) {
    if (!sdk || typeof sdk.doc !== 'function' || typeof sdk.collection !== 'function') {
        throw new Error('Firestore SDK is required');
    }
    if (!binding || typeof binding !== 'object' || !binding.firestoreInstance ||
        typeof binding.projectId !== 'string' || !binding.projectId ||
        typeof binding.databaseId !== 'string' || !binding.databaseId) {
        throw new Error('A trusted Firestore binding is required');
    }

    const RETIRED_ROUTE_ID = '702112ТЕСТ1А';
    const trustedDb = Object.freeze({
        id: Symbol('firestore-binding'),
        firestoreInstance: binding.firestoreInstance,
        projectId: binding.projectId,
        databaseId: binding.databaseId
    });
    const documentAuthorities = new WeakMap();
    const collectionAuthorities = new WeakMap();
    const retiredDocumentPaths = new Set();
    const retirementVersions = new Map();
    const normalize = value => typeof value === 'string'
        ? value.normalize('NFKC').trim().toUpperCase()
        : '';
    const isRetired = value => {
        const normalized = normalize(value);
        return normalized === RETIRED_ROUTE_ID || normalized.startsWith(RETIRED_ROUTE_ID + '_');
    };
    const validateSegment = (value, label) => {
        if (typeof value !== 'string' || !value || value !== value.trim() || value.includes('/')) {
            throw new Error(label + ' must be one non-empty Firestore path segment');
        }
        return value;
    };
    const issueAuthority = (kind, collectionName, documentId, routeScope) => {
        const collectionSegment = validateSegment(collectionName, 'collectionName');
        const path = kind === 'document'
            ? collectionSegment + '/' + validateSegment(documentId, 'documentId')
            : collectionSegment;
        if (typeof routeScope !== 'string' || !routeScope.trim()) throw new Error('routeScope is required for mutation authority');
        const retired = isRetired(routeScope) || path.split('/').some(isRetired);
        const ownerScope = normalize(routeScope);
        const fenceKey = kind + ':' + path;
        if (retired) retirementVersions.set(fenceKey, (retirementVersions.get(fenceKey) || 0) + 1);
        const handle = Object.freeze(Object.create(null));
        const record = Object.freeze({
            bindingId: trustedDb.id,
            kind,
            path,
            retired,
            ownerScope,
            fenceKey,
            retirementVersion: retirementVersions.get(fenceKey) || 0
        });
        (kind === 'document' ? documentAuthorities : collectionAuthorities).set(handle, record);
        if (kind === 'document' && retired) retiredDocumentPaths.add(path);
        return handle;
    };
    const resolveAuthority = (handle, kind, expectedRecord) => {
        if (!handle || typeof handle !== 'object') throw new Error('Facade-issued mutation authority is required');
        const record = (kind === 'document' ? documentAuthorities : collectionAuthorities).get(handle);
        if (!record || (expectedRecord && record !== expectedRecord) || record.bindingId !== trustedDb.id || record.kind !== kind) {
            throw new Error('Facade-issued mutation authority is required');
        }
        if (record.retired || record.retirementVersion !== (retirementVersions.get(record.fenceKey) || 0) ||
            (kind === 'document' && retiredDocumentPaths.has(record.path))) {
            throw new Error('Retired TEST target mutation is disabled pending Phase B retirement.');
        }
        return record;
    };
    const immutableSnapshot = value => {
        const active = new Set();
        const copy = current => {
            if (current === undefined) throw new Error('Undefined Firestore mutation values are unsupported');
            if (current === null || typeof current === 'string' || typeof current === 'boolean') return current;
            if (typeof current === 'number') {
                if (!Number.isFinite(current)) throw new Error('Firestore mutation numbers must be finite');
                return current;
            }
            if (typeof current !== 'object') throw new Error('Unsupported Firestore mutation value');
            const prototype = Object.getPrototypeOf(current);
            const array = prototype === Array.prototype;
            if (!array && prototype !== Object.prototype) throw new Error('Unsupported non-plain Firestore mutation value');
            if (active.has(current)) throw new Error('Cyclic Firestore mutation data is unsupported');
            active.add(current);
            const keys = Reflect.ownKeys(current);
            const output = array ? [] : {};
            const expectedArrayKeys = array
                ? Array.from({ length: current.length }, (_, index) => String(index)).concat('length')
                : null;
            if (array && (keys.length !== expectedArrayKeys.length ||
                expectedArrayKeys.some(key => !keys.includes(key)))) throw new Error('Mutation arrays must be dense and ordinary');
            for (let index = 0; index < keys.length; index++) {
                const key = keys[index];
                if (array && key === 'length') continue;
                if (typeof key !== 'string') throw new Error('Symbol mutation fields are unsupported');
                if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
                    throw new Error('Dangerous Firestore mutation field name is unsupported');
                }
                const descriptor = Object.getOwnPropertyDescriptor(current, key);
                if (!descriptor || !descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
                    throw new Error('Mutation data must use exact own data properties');
                }
                Object.defineProperty(output, key, {
                    value: copy(descriptor.value),
                    enumerable: true,
                    writable: true,
                    configurable: true
                });
            }
            active.delete(current);
            if ((array && Object.getPrototypeOf(output) !== Array.prototype) ||
                (!array && Object.getPrototypeOf(output) !== Object.prototype)) {
                throw new Error('Mutation snapshot prototype changed');
            }
            return Object.freeze(output);
        };
        return copy(value);
    };
    const protectedOwnerField = key => {
        const segments = String(key).split('.');
        return segments[segments.length - 1] === 'routeKey' || segments[segments.length - 1] === 'buildingId';
    };
    const assertOwnerEvidence = (value, ownerScope) => {
        if (!value || typeof value !== 'object') return;
        const keys = Object.keys(value);
        for (let index = 0; index < keys.length; index++) {
            const key = keys[index];
            const descriptor = Object.getOwnPropertyDescriptor(value, key);
            const child = descriptor.value;
            if (protectedOwnerField(key)) {
                if (isRetired(child)) throw new Error('Retired TEST target mutation is disabled pending Phase B retirement.');
                if (typeof child !== 'string' || normalize(child) !== ownerScope) {
                    throw new Error('Contradictory mutation owner evidence');
                }
            }
            assertOwnerEvidence(child, ownerScope);
        }
    };
    const snapshotPayload = (value, record) => {
        const snapshot = immutableSnapshot(value);
        if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw new Error('Mutation payload must be a plain object');
        assertOwnerEvidence(snapshot, record.ownerScope);
        return snapshot;
    };
    const snapshotSetOptions = options => {
        const snapshot = immutableSnapshot(options);
        const keys = Object.keys(snapshot);
        if (keys.length !== 1 || keys[0] !== 'merge' || typeof snapshot.merge !== 'boolean') {
            throw new Error('Only { merge: boolean } set options are supported');
        }
        return snapshot;
    };
    const canonicalFieldSegments = value => {
        if (typeof value !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(value)) {
            throw new Error('Only canonical string update field paths are supported');
        }
        return value.split('.');
    };
    const assertNonConflictingFields = paths => {
        for (let left = 0; left < paths.length; left++) {
            for (let right = left + 1; right < paths.length; right++) {
                const shorter = paths[left].length <= paths[right].length ? paths[left] : paths[right];
                const longer = shorter === paths[left] ? paths[right] : paths[left];
                if (shorter.every((segment, index) => segment === longer[index])) {
                    throw new Error('Duplicate or conflicting update field paths are unsupported');
                }
            }
        }
    };
    const snapshotUpdateArguments = (args, record) => {
        if (args.length === 1) {
            const snapshot = snapshotPayload(args[0], record);
            const paths = Object.keys(snapshot).map(canonicalFieldSegments);
            assertNonConflictingFields(paths);
            return [snapshot];
        }
        if (args.length < 2 || args.length % 2 !== 0) throw new Error('Unsupported Firestore update signature');
        const stable = [], paths = [];
        for (let index = 0; index < args.length; index += 2) {
            const field = args[index];
            const segments = canonicalFieldSegments(field);
            const value = immutableSnapshot(args[index + 1]);
            assertOwnerEvidence(value, record.ownerScope);
            if (protectedOwnerField(field)) {
                if (isRetired(value)) throw new Error('Retired TEST target mutation is disabled pending Phase B retirement.');
                if (typeof value !== 'string' || normalize(value) !== record.ownerScope) {
                    throw new Error('Contradictory mutation owner evidence');
                }
            }
            paths.push(segments);
            stable.push(field, value);
        }
        assertNonConflictingFields(paths);
        return stable;
    };
    const rawReference = record => record.kind === 'document'
        ? sdk.doc(trustedDb.firestoreInstance, record.path)
        : sdk.collection(trustedDb.firestoreInstance, record.path);

    const api = Object.assign({}, sdk);
    api.routeDoc = function (db, collectionName, documentId) {
        return sdk.doc(db, collectionName, documentId);
    };
    api.mutationDoc = function (collectionName, documentId, routeScope) {
        return issueAuthority('document', collectionName, documentId, routeScope);
    };
    api.mutationCollection = function (collectionName, routeScope) {
        return issueAuthority('collection', collectionName, null, routeScope);
    };
    if (typeof sdk.setDoc === 'function') api.setDoc = function (handle, data, ...rest) {
        if (rest.length > 1) throw new Error('Unsupported Firestore set signature');
        const record = resolveAuthority(handle, 'document');
        const payload = snapshotPayload(data, record);
        const options = rest.length ? [snapshotSetOptions(rest[0])] : [];
        resolveAuthority(handle, 'document', record);
        return sdk.setDoc(rawReference(record), payload, ...options);
    };
    if (typeof sdk.updateDoc === 'function') api.updateDoc = function (handle, ...args) {
        const record = resolveAuthority(handle, 'document');
        const updateArguments = snapshotUpdateArguments(args, record);
        resolveAuthority(handle, 'document', record);
        return sdk.updateDoc(rawReference(record), ...updateArguments);
    };
    if (typeof sdk.deleteDoc === 'function') api.deleteDoc = function (handle, ...rest) {
        if (rest.length) throw new Error('Unsupported Firestore delete signature');
        const record = resolveAuthority(handle, 'document');
        resolveAuthority(handle, 'document', record);
        return sdk.deleteDoc(rawReference(record));
    };
    if (typeof sdk.addDoc === 'function') api.addDoc = function (handle, data, ...rest) {
        if (rest.length) throw new Error('Unsupported Firestore add signature');
        const record = resolveAuthority(handle, 'collection');
        const payload = snapshotPayload(data, record);
        resolveAuthority(handle, 'collection', record);
        return sdk.addDoc(rawReference(record), payload);
    };
    return api;
}

if (typeof module !== 'undefined' && module.exports) module.exports = { installFirestoreClient };
