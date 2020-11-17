const _ = require('lodash');
const cuid = require('cuid');

// This module is responsible for managing all of the documents (apostrophe "docs")
// in the `aposDocs` mongodb collection.
//
// The `getManager` method should be used to obtain a reference to the module
// that manages a particular doc type, so that you can benefit from behavior
// specific to that module. One method of this module that you may sometimes use directly
// is `apos.doc.find()`, which returns a [cursor](server-@apostrophecms/cursor.html) for
// fetching documents of all types. This is useful when implementing something
// like the [@apostrophecms/search](../@apostrophecms/search/index.html) module.
//
// ## Options
//
// ** `advisoryLockTimeout`: Apostrophe locks documents while they are
// being edited so that another user, or another tab for the same user,
// does not inadvertently interfere. These locks are refreshed frequently
// by the browser while they are held. By default, if the browser
// is not heard from for 30 seconds, the lock expires. Note that
// the browser refreshes the lock every 5 seconds. This timeout should
// be quite short as there is no longer any reliable way to force a browser
// to unlock the document when leaving the page.

module.exports = {
  options: {
    alias: 'doc',
    advisoryLockTimeout: 30
  },
  async init(self, options) {
    self.managers = {};
    self.enableBrowserData();
    await self.enableCollection();
    await self.createIndexes();
  },
  restApiRoutes(self, options) {
    return {
      // GET /api/v1/@apostrophecms/doc/_id supports only the universal query
      // features, but works for any document type, Simplifies browser-side
      // logic for redirects to foreign documents; the frontend only has to
      // know the doc _id.
      async getOne(req, _id) {
        return self.find(req, { _id }).toObject();
      },

      // PATCH /api/v1/@apostrophecms/doc/_id works for any document type,
      // at the expense of one extra query to determine what module should
      // be asked to do the work. Simplifies browser-side logic for
      // on-page editing: the frontend only has to know the doc _id.
      async patch(req, _id) {
        const doc = await self.find(req, { _id }).project({
          type: 1,
          slug: 1
        }).toObject();
        if (!doc) {
          throw self.apos.error('notfound');
        }
        if (self.apos.page.isPage(doc)) {
          return self.apos.page.patch(req, _id);
        } else {
          const manager = self.apos.doc.getManager(doc.type);
          return manager.patch(req, _id);
        }
      }
    };
  },
  apiRoutes(self, options) {
    return {
      post: {
        async slugTaken(req) {
          if (!req.user) {
            throw self.apos.error('notfound');
          }
          const slug = self.apos.launder.string(req.body.slug);
          const _id = self.apos.launder.id(req.body._id);
          const criteria = { slug: slug };
          if (_id) {
            criteria._id = { $ne: _id };
          }
          const doc = await self.find(req, criteria).permission(false).trash(null).project({ slug: 1 }).toObject();
          if (doc) {
            throw self.apos.error('conflict');
          } else {
            return {
              available: true
            };
          }
        }
      }
    };
  },
  routes(self, options) {
    return {
      post: {
        // POST to /@apostrophecms/doc/api/v1/get-as-patched with
        // the properties `url`, `_id`, `type` and `patches` in order
        // to fetch the given document, apply the supplied patches
        // without actually saving them, and then render the given
        // `url` exactly as if it were a normal GET request for it,
        // substituting the patched doc for any query that would
        // otherwise return it. This is useful for re-rendering after
        // undo/redo, given that we don't actually save edits
        // on the fly, undo/redo included.
        async getAsPatched(req, res) {
          let url = self.apos.launder.string(req.body.url);
          const _id = self.apos.launder.id(req.body._id);
          const type = self.apos.launder.string(req.body.type);
          const patches = Array.isArray(req.body.patches) ? req.body.patches : [];
          const manager = self.getManager(type);
          if (!manager) {
            return self.routeSendError(req, self.apos.error('invalid'));
          }
          const query = await manager.find(req, { _id });
          if (self.apos.instanceOf(manager, '@apostrophecms/page-type')) {
            query.ancestors(true);
          }
          const doc = await query.toObject();
          if (!doc) {
            return self.routeSendError(req, self.apos.error('notfound'));
          }
          for (const input of patches) {
            if (self.apos.page.isPage(doc)) {
              await self.apos.page.applyPatch(req, doc, input);
            } else {
              await manager.applyPatch(req, doc, input);
            }
          }
          // As far as applyPatch is concerned, relationships are
          // real, but as far as mongo is concerned they're not, so
          // we have to get back to real _ids before we try to substitute
          // this document in the result of a mongo query
          manager.prepareRelationshipsForStorage(req, doc);
          const key = cuid();
          await self.apos.cache.set('as-patched', key, self.apos.util.clonePermanent(doc), 300);
          if (url.indexOf('?') !== -1) {
            url += `&apos-as-patched=${key}`;
          } else {
            url += `?apos-as-patched=${key}`;
          }
          return res.redirect(url);
        }
      }
    };
  },
  handlers(self, options) {
    return {
      '@apostrophecms/doc-type:beforeInsert': {
        testPermissionsAndAddIdAndCreatedAt(req, doc, options) {
          self.testInsertPermissions(req, doc, options);
          if (!doc._id) {
            doc._id = self.apos.util.generateId();
          }
          doc.metaType = 'doc';
          doc.createdAt = new Date();
          if (doc.trash == null) {
            // Not always in the schema, so ensure it's true or false
            // to simplify queries and indexing
            doc.trash = false;
          }
        },
        // Makes using our model APIs directly less tedious
        ensureAreaAndWidgetIds(req, doc, options) {
          self.apos.area.walk(doc, area => {
            if (!area._id) {
              area._id = self.apos.util.generateId();
            }
            for (const item of (area.items || [])) {
              if (!item._id) {
                item._id = self.apos.util.generateId();
              }
            }
          });
        }
      },
      '@apostrophecms/doc-type:beforeSave': {
        ensureSlugSortifyAndUpdatedAt(req, doc, options) {
          self.ensureSlug(doc);
          const manager = self.getManager(doc.type);
          _.each(manager.schema, function (field) {
            if (field.sortify) {
              doc[field.name + 'Sortified'] = self.apos.util.sortify(doc[field.name] ? doc[field.name] : '');
            }
          });
          doc.updatedAt = new Date();
        }
      },
      fixUniqueError: {
        async fixUniqueSlug(req, doc) {
          doc.slug += Math.floor(Math.random() * 10).toString();
        }
      },
      '@apostrophecms/doc-type:beforeUpdate': {
        async checkPermissionsBeforeUpdate(req, doc, options) {
          if (options.permissions !== false) {
            if (!self.apos.permission.can(req, 'edit', doc)) {
              throw new Error('forbidden');
            }
          }
        }
      },
      '@apostrophecms/version:unversionedFields': {
        baseUnversionedFields(req, doc, fields) {
          fields.push('visibility');
        }
      }
    };
  },
  methods(self, options) {
    return {
      async enableCollection() {
        self.db = await self.apos.db.collection('aposDocs');
      },
      async createSlugIndex() {
        const params = self.getSlugIndexParams();
        return self.db.createIndex(params, { unique: true });
      },
      getSlugIndexParams() {
        return { slug: 1 };
      },
      getPathLevelIndexParams() {
        return {
          path: 1,
          level: 1
        };
      },
      async createIndexes() {
        await self.db.createIndex({ type: 1 }, {});
        await self.createSlugIndex();
        await self.db.createIndex({ titleSortified: 1 }, {});
        await self.db.createIndex({ updatedAt: -1 }, {});
        await self.db.createIndex({ 'advisoryLock._id': 1 }, {});
        await self.createTextIndex();
        await self.db.createIndex({ parkedId: 1 }, {});
      },
      async createTextIndex() {
        try {
          return await attempt();
        } catch (e) {
          // We are experiencing what may be a mongodb bug in which these indexes
          // have different weights than expected and the createIndex call fails.
          // If this happens drop and recreate the text index
          if (e.toString().match(/with different options/)) {
            self.apos.util.warn('Text index has unexpected weights or other misconfiguration, reindexing');
            await self.db.dropIndex('highSearchText_text_lowSearchText_text_title_text_searchBoost_text');
            return await attempt();
          } else {
            throw e;
          }
        }
        function attempt() {
          return self.db.createIndex({
            highSearchText: 'text',
            lowSearchText: 'text',
            title: 'text',
            searchBoost: 'text'
          }, {
            default_language: self.options.searchLanguage || 'none',
            weights: {
              title: 100,
              searchBoost: 150,
              highSearchText: 10,
              lowSearchText: 2
            }
          });
        }
      },
      async ensurePathLevelIndex() {
        const params = self.getPathLevelIndexParams();
        return self.db.createIndex(params, {});
      },

      // Returns a query based on the permissions
      // associated with the given request. You can then
      // invoke chainable query builders like `.project()`,
      // `limit()`, etc. to alter the query before ending
      // the chain with an awaitable method like `toArray()`
      // to obtain documents.
      //
      // `req` determines what documents the user is allowed
      // to see. `criteria` is a MongoDB criteria object,
      // see the MongoDB documentation for basics on this.
      // If an `options` object is present, query builder
      // methods with the same name as each property are
      // invoked, with the value of that property. This is
      // an alternative to chaining methods.
      //
      // This method returns a query, not docs! You
      // need to chain it with toArray() or other
      // query methods and await the result:
      //
      // await apos.doc.find(req, { type: 'foobar' }).toArray()

      find(req, criteria = {}, options = {}) {
        return self.apos.modules['@apostrophecms/any-doc-type'].find(req, criteria, options);
      },

      // **Most often you will insert or update docs via the
      // insert and update methods of the appropriate doc manager.**
      // This method is for implementation use in those objects,
      // and for times when you wish to explicitly bypass type-specific
      // lifecycle events.
      //
      // Insert the given document. If the slug is not
      // unique it is made unique. `beforeInsert`, `beforeSave`, `afterInsert`
      // and `afterSave` events are emitted via the appropriate doc type manager,
      // then awaited. They receive `(req, doc, options)`.
      //
      // Returns the inserted document.
      //
      // If the slug property is not set, the title
      // property is converted to a slug. If neither
      // property is set, an error is thrown.
      //
      // The `edit-type-name` permission is checked based on
      // doc.type.
      //
      // If a unique key error occurs, the `@apostrophecms/doc:fixUniqueError`
      // event is emitted and the doc is passed to all handlers.
      // Modify the document to fix any properties that may need to be
      // more unique due to a unique index you have added. It is
      // not possible to know which property was responsible. This method
      // takes care of the slug property directly.
      //
      // The `options` object may be omitted completely.
      //
      // If `options.permissions` is set explicitly to
      // `false`, permissions checks are bypassed.
      async insert(req, doc, options) {
        options = options || {};
        const m = self.getManager(doc.type);
        await m.emit('beforeInsert', req, doc, options);
        await m.emit('beforeSave', req, doc, options);
        await self.insertBody(req, doc, options);
        await m.emit('afterInsert', req, doc, options);
        await m.emit('afterSave', req, doc, options);
        await m.emit('afterLoad', req, [ doc ]);
        return doc;
      },
      // Updates the given document. If the slug is not
      // unique it is made unique. `beforeUpdate`, `beforeSave`,
      // `afterUpdate` and `afterSave` events are emitted
      // via the appropriate doc type manager.
      //
      // The second argument must be the document itself.
      // `$set`, `$inc`, etc. are NOT available via
      // this interface. This simplifies the implementation
      // of permissions and workflow. If you need to
      // update an object, find it first and then update it.
      //
      // Returns the updated doc.
      //
      // If a unique key error occurs, the `@apostrophecms/doc:fixUniqueError`
      // event is emitted and the doc is passed to all handlers.
      // Modify the document to fix any properties that may need to be
      // more unique due to a unique index you have added. It is
      // not possible to know which property was responsible. This method
      // takes care of the slug property directly.
      //
      // The `options` object may be omitted completely.
      //
      // If `options.permissions` is set explicitly to
      // `false`, permissions checks are bypassed.
      async update(req, doc, options) {
        options = options || {};
        const m = self.getManager(doc.type);
        await m.emit('beforeUpdate', req, doc, options);
        await m.emit('beforeSave', req, doc, options);
        await self.updateBody(req, doc, options);
        await m.emit('afterUpdate', req, doc, options);
        await m.emit('afterSave', req, doc, options);
        await m.emit('afterLoad', req, [ doc ]);
        return doc;
      },
      // Recursively visit every property of a doc,
      // invoking an iterator function for each one. Optionally
      // deletes properties.
      //
      // The `_originalWidgets` property and its subproperties
      // are not walked because they are temporary information
      // present only to preserve widgets during save operations
      // performed by users without permissions for those widgets.
      //
      // The second argument must be a function that takes
      // an object, a key, a value, a "dot path" and an
      // array containing the ancestors of this property
      // (beginning with the original `doc` and including
      // "object") and explicitly returns `false` if that property
      // should be discarded. If any other value is returned the
      // property remains.
      //
      // Remember, keys can be numbers; toString() is
      // your friend.
      //
      // If the original object looks like:
      //
      // { a: { b: 5 } }
      //
      // Then when the iterator is invoked for b, the
      // object will be { b: 5 }, the key
      // will be `b`, the value will be `5`, the dotPath
      // will be the string `a.b`, and ancestors will be
      // [ { a: { b: 5 } } ].
      //
      // You do not need to pass the `_dotPath` and `_ancestors` arguments.
      // They are used for recursive invocation.
      walk(doc, iterator, _dotPath, _ancestors) {
        // We do not use lodash here because of
        // performance issues.
        //
        // Pruning big nested objects is not something we
        // can afford to do slowly. -Tom
        if (_dotPath !== undefined) {
          _dotPath += '.';
        } else {
          _dotPath = '';
        }
        _ancestors = (_ancestors || []).concat(doc);
        const remove = [];
        for (const key in doc) {
          const __dotPath = _dotPath + key.toString();
          const ow = '_originalWidgets';
          if (__dotPath === ow || __dotPath.substring(0, ow.length) === ow + '.') {
            continue;
          }
          if (iterator(doc, key, doc[key], __dotPath, _ancestors) === false) {
            remove.push(key);
          } else {
            const val = doc[key];
            if (typeof val === 'object') {
              self.walk(val, iterator, __dotPath, _ancestors.concat([ doc ]));
            }
          }
        }
        for (const key of remove) {
          delete doc[key];
        }
      },
      // Retry the given "actor" async function until it
      // does not yield a MongoDB error related to
      // unique indexes. The actor is not passed
      // any arguments and it will be awaited. If
      // an error related to uniqueness does occur, this module emits the
      // `fixUniqueError` event with `req, doc` before
      // the next retry. This is your opportunity to
      // tweak properties relating to unique indexes
      // this module does not know about.
      //
      // Passes on the return value of `actor`.
      //
      // Will make no more than 20 attempts, which statistically eliminates
      // any chance we just didn't try hard enough while avoiding
      // an infinite loop if the unique key error is due to a property
      // there is no handling for.
      async retryUntilUnique(req, doc, actor) {
        const maxAttempts = 20;
        let attempt = 0;
        let firstError;
        while (true) {
          try {
            return await actor();
          } catch (err) {
            if (!self.isUniqueError(err)) {
              throw err;
            }
            if (!firstError) {
              firstError = err;
            }
            attempt++;
            if (attempt === maxAttempts) {
              // Odds are now 1 in 100000000000000000000 that it is really due
              // to a duplicate path or slug; a far more likely explanation is
              // that another docFixUniqueError handler is needed to address
              // an additional property that has to be unique. Report the
              // original error to avoid confusion ("ZOMG, what are all these digits!")
              firstError.aposAddendum = 'retryUntilUnique failed, most likely you need another docFixUniqueError method to handle another property that has a unique index, reporting original error';
              throw firstError;
            }
            await self.emit('fixUniqueError', req, doc);
          }
        }
      },
      // Called by `docBeforeInsert` to confirm that the user
      // has the appropriate permissions for the doc's type
      // and, in some extensions of Apostrophe, the new doc's
      // content.
      testInsertPermissions(req, doc, options) {
        if (!(options.permissions === false)) {
          if (!self.apos.permission.can(req, 'edit', doc)) {
            throw self.apos.error('forbidden');
          }
        }
      },
      // If the doc does not yet have a slug, add one based on the
      // title; throw an error if there is no title
      ensureSlug(doc) {
        if (!doc.slug || doc.slug === 'none') {
          if (doc.title) {
            doc.slug = self.apos.util.slugify(doc.title);
          } else if (doc.slug !== 'none') {
            throw self.apos.error('invalid', 'Document has neither slug nor title, giving up');
          }
        }
      },
      // Do not call this yourself, it is called
      // by .update(). You will usually want to call the
      // update method of the appropriate doc type manager instead:
      //
      // self.apos.doc.getManager(doc.type).update(...)
      //
      // You may override this method to change the implementation.
      async updateBody(req, doc, options) {
        return self.retryUntilUnique(req, doc, async function () {
          return self.db.replaceOne({ _id: doc._id }, self.apos.util.clonePermanent(doc));
        });
      },
      // Insert the given document. Called by `.insert()`. You will usually want to
      // call the update method of the appropriate doc type manager instead:
      //
      // ```javascript
      // self.apos.doc.getManager(doc.type).update(...)
      // ```
      //
      // However you can override this method to alter the
      // implementation.
      async insertBody(req, doc, options) {
        return self.retryUntilUnique(req, doc, async function () {
          return self.db.insertOne(self.apos.util.clonePermanent(doc));
        });
      },
      // Given either an id (as a string) or a criteria
      // object, return a criteria object.
      idOrCriteria(idOrCriteria) {
        if (typeof idOrCriteria === 'object') {
          return idOrCriteria;
        } else {
          return { _id: idOrCriteria };
        }
      },
      // Is this MongoDB error related to uniqueness? Great for retrying on duplicates.
      // Used heavily by the pages module and no doubt will be by other things.
      //
      // There are three error codes for this: 13596 ("cannot change _id of a document")
      // and 11000 and 11001 which specifically relate to the uniqueness of an index.
      // 13596 can arise on an upsert operation, especially when the _id is assigned
      // by the caller rather than by MongoDB.
      //
      // IMPORTANT: you are responsible for making sure ALL of your unique indexes
      // are accounted for before retrying... otherwise an infinite loop will
      // likely result.
      isUniqueError(err) {
        if (!err) {
          return false;
        }
        return err.code === 13596 || err.code === 13596 || err.code === 11000 || err.code === 11001;
      },
      // Set the manager object corresponding
      // to a given doc type. Typically `manager`
      // is a module that subclasses `@apostrophecms/doc-type`
      // (or its subclasses `@apostrophecms/piece-type` and `@apostrophecms/page-type`).
      setManager(type, manager) {
        self.managers[type] = manager;
      },
      // Returns an array of all of the doc types that have a registered manager.
      getManaged() {
        return Object.keys(self.managers);
      },
      // Fetch the manager object corresponding to a given
      // doc type. The manager object provides methods such
      // as find() specific to that type.
      //
      // If no manager has been registered, this method will
      // return undefined. **All** doc types used in your project must
      // have a registered manager (hint: all subclasses of
      // pieces, the `data.global` doc, and page types registered
      // with `@apostrophecms/page` always have one).
      getManager(type) {
        return self.managers[type];
      },
      // Lock the given doc to a given `contextId`, such
      // that other calls to `apos.doc.lock` for that doc id will
      // fail unless they have the same `contextId`. If
      // `options.force` is true, any existing lock is
      // overwritten. The `options` argument may be
      // omitted entirely.
      //
      // You cannot lock a document that has not yet been inserted,
      // nor do you need to.
      //
      // If a lock cannot be obtained due to a conflict
      // a 'locked' error is thrown, with the `me: true` property if
      // the lock is held by the same user in another tab, or
      // `username` and `title` properties if the lock is held
      // by someone else. Other errors are thrown as appropriate.
      //
      // If you need to refresh a lock in order to avoid
      // expiration, just lock it again. As long as the contextId
      // is the same as the current lock holder you will receive
      // another successful response.
      //
      // This method will set the `advisoryLock` property of the
      // document both in the database and in the `doc` object
      // that you pass to it. This ensures it is present if you
      // follow this call up with an `update()` of the document.

      async lock(req, doc, contextId, options) {
        if (!options) {
          options = {};
        }
        if (!(req && req.res)) {
          // Use 'error' because this is always a code bug, not a bad
          // HTTP request, and the message should not be disclosed to the client
          throw self.apos.error('error', 'You forgot to pass req as the first argument');
        }
        if (!doc && doc._id) {
          throw self.apos.error('invalid', 'No doc was passed');
        }
        const _id = doc._id;
        if (!contextId) {
          throw self.apos.error('invalid', 'no contextId was passed');
        }
        let criteria = { _id };
        if (!options.force) {
          criteria.$or = [
            {
              advisoryLock: {
                $exists: 0
              }
            },
            {
              'advisoryLock.updatedAt': {
                $lt: self.getAdvisoryLockExpiration()
              }
            },
            {
              'advisoryLock._id': contextId
            }
          ];
        }
        // Prevent nuisance locking by matching only
        // documents the user can edit
        criteria = {
          $and: [
            criteria,
            self.apos.permission.criteria(req, 'edit')
          ]
        };
        doc.advisoryLock = {
          username: req.user && req.user.username,
          title: req.user && req.user.title,
          _id: contextId,
          updatedAt: new Date()
        };
        const result = await self.db.updateOne(criteria, {
          $set: {
            advisoryLock: doc.advisoryLock
          }
        });
        if (!result.result.nModified) {
          const info = await self.db.findOne({
            _id
          }, {
            projection: {
              advisoryLock: 1
            }
          });
          if (!info) {
            throw self.apos.error('notfound');
          }
          if (!info.advisoryLock) {
            // Nobody else has a lock but you couldn't get one —
            // must be permissions
            throw self.apos.error('forbidden');
          }
          if (!info.advisoryLock) {
            // Nobody else has a lock but you couldn't get one —
            // must be permissions
            throw self.apos.error('forbidden');
          }
          if (info.advisoryLock.username === req.user.username) {
            throw self.apos.error('locked', {
              me: true
            });
          }
          throw self.apos.error('locked', {
            title: info.advisoryLock.title,
            username: info.advisoryLock.username
          });
        }
      },
      // Any advisory lock whose `updatedAt` time is older than the Date
      // object returned by this method should be considered expired
      getAdvisoryLockExpiration() {
        return new Date(Date.now() - 1000 * self.options.advisoryLockTimeout);
      },
      // Release a document lock set via `lock` for a particular contextId.
      // If the lock is already gone no error occurs.
      //
      // This method will unset the `advisoryLock` property of the
      // document both in the database and in the `doc` object
      // that you pass to it. This ensures it is present if you
      // follow this call up with an `update()` of the document.
      async unlock(req, doc, contextId) {
        if (!(req && req.res)) {
          // Use 'error' because this is always a code bug, not a bad
          // HTTP request, and the message should not be disclosed to the client
          throw self.apos.error('error', 'You forgot to pass req as the first argument');
        }
        const id = doc && doc._id;
        if (!id) {
          throw self.apos.error('invalid', 'no doc');
        }
        if (!contextId) {
          throw self.apos.error('invalid', 'no contextId');
        }
        await self.db.updateOne({
          _id: id,
          'advisoryLock._id': contextId
        }, {
          $unset: {
            advisoryLock: 1
          }
        });
        delete doc.advisoryLock;
      },
      // Returns the field names necessary to build URLs
      // for typical doc types. If a cursor specific to a
      // doc type is used, the `getUrlFields` method of
      // that module is called instead. This method is
      // used to implement "projections" for the
      // `_url` computed property
      getDefaultUrlFields() {
        return [
          'type',
          'slug'
        ];
      },
      getBrowserData(req) {
        return {
          action: self.action
        };
      }
    };
  }
};
