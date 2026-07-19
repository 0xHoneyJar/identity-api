import type {CredentialLinkRepository,LinkIntentRepository} from "../ports/index.js";
import type {CredentialKey} from "../domain/CredentialKey.js";
import type {CredentialLink} from "../domain/CredentialLink.js";
import type {LinkIntent} from "../domain/LinkIntent.js";
export class InMemoryCredentialLinks implements CredentialLinkRepository{private map=new Map<string,CredentialLink>();async findByKey(k:CredentialKey){return this.map.get(k.toStorageKey())??null}async save(v:CredentialLink){this.map.set(v.key.toStorageKey(),v)}}
export class InMemoryLinkIntents implements LinkIntentRepository{private map=new Map<string,LinkIntent>();seed(v:LinkIntent){this.map.set(v.id,v)}async findByIdForUpdate(id:string){return this.map.get(id)??null}async save(v:LinkIntent){this.map.set(v.id,v)}}
