import db from '../database';
import user from '../user';
import plugins from '../plugins';
import cache from '../cache';

type GroupsType = {
    leave: (groupNames: string | string[], uid: number) => Promise<void>
    isMemberOfGroups: (uid: number, groupNames: string[]) => Promise<boolean[]>
    clearCache: (uid: number, groupsToLeave: string[]) => Promise<void>
    getGroupsFields: (groupsToLeave: string[], fields: string[]) => Promise<Group[]>
    isPrivilegeGroup: (name: string) => boolean
    leaveAllGroups: (uid: number) => Promise<void>
    destroy: (r:string) => Promise<void>
    rejectMembership: (groups: string[], uid: number) => Promise<void>
    kick: (uid: number, groupName: string, isOwner: boolean) => Promise<void>
}

type Group = {
    name: string
    memberCount: number
    hidden: boolean
}

type UserDataType = {
    groupTitleArray: string[]
}

module.exports = function (Groups: GroupsType) {
    async function clearGroupTitleIfSet(groupNames: string[], uid: number) {
        groupNames = groupNames.filter(groupName => groupName !== 'registered-users' && !Groups.isPrivilegeGroup(groupName));
        if (!groupNames.length) {
            return;
        }
        // The next line calls a function in a module that has not been updated to TS yet
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call
        const userData: UserDataType = await user.getUserData(uid) as UserDataType;
        if (!userData) {
            return;
        }

        const newTitleArray: string[] = userData.groupTitleArray.filter(groupTitle => !groupNames.includes(groupTitle));
        if (newTitleArray.length) {
            // The next line calls a function in a module that has not been updated to TS yet
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
            await db.setObjectField(`user:${uid}`, 'groupTitle', JSON.stringify(newTitleArray));
        } else {
            // The next line calls a function in a module that has not been updated to TS yet
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
            await db.deleteObjectField(`user:${uid}`, 'groupTitle');
        }
    }

    Groups.leave = async function (groupNames, uid) {
        if (Array.isArray(groupNames) && !groupNames.length) {
            return;
        }
        if (!Array.isArray(groupNames)) {
            groupNames = [groupNames];
        }

        const isMembers: boolean[] = await Groups.isMemberOfGroups(uid, groupNames);

        const groupsToLeave: string[] = groupNames.filter((groupName, index) => isMembers[index]);
        if (!groupsToLeave.length) {
            return;
        }

        await Promise.all([
            // The next line calls a function in a module that has not been updated to TS yet
            // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
            db.sortedSetRemove(groupsToLeave.map(groupName => `group:${groupName}:members`), uid),
            // The next line calls a function in a module that has not been updated to TS yet
            // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
            db.setRemove(groupsToLeave.map(groupName => `group:${groupName}:owners`), uid),
            // The next line calls a function in a module that has not been updated to TS yet
            // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
            db.decrObjectField(groupsToLeave.map(groupName => `group:${groupName}`), 'memberCount'),
        ]);

        await Groups.clearCache(uid, groupsToLeave);
        cache.del(groupsToLeave.map(name => `group:${name}:members`));

        const groupData = await Groups.getGroupsFields(groupsToLeave, ['name', 'hidden', 'memberCount']);
        if (!groupData) {
            return;
        }

        const emptyPrivilegeGroups = groupData.filter(g => g && Groups.isPrivilegeGroup(g.name) && g.memberCount === 0);
        const visibleGroups = groupData.filter(g => g && !g.hidden);

        const promises = [];
        if (emptyPrivilegeGroups.length) {
            promises.push(Groups.destroy, emptyPrivilegeGroups);
        }
        if (visibleGroups.length) {
            promises.push(
                // The next line calls a function in a module that has not been updated to TS yet
                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
                db.sortedSetAdd,
                'groups:visible:memberCount',
                visibleGroups.map(groupData => groupData.memberCount),
                visibleGroups.map(groupData => groupData.name)
            );
        }

        await Promise.all(promises);

        await clearGroupTitleIfSet(groupsToLeave, uid);

        // The next line calls a function in a module that has not been updated to TS yet
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
        await plugins.hooks.fire('action:group.leave', {
            groupNames: groupsToLeave,
            uid: uid,
        });
    };

    Groups.leaveAllGroups = async function (uid) {
        // The next line calls a function in a module that has not been updated to TS yet
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
        const groups: string[] = await db.getSortedSetRange('groups:createtime', 0, -1) as string[];
        await Promise.all([
            Groups.leave(groups, uid),
            Groups.rejectMembership(groups, uid),
        ]);
    };

    Groups.kick = async function (uid, groupName, isOwner) {
        if (isOwner) {
            // If the owners set only contains one member, error out!
            // The next line calls a function in a module that has not been updated to TS yet
            // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
            const numOwners: number = await db.setCount(`group:${groupName}:owners`) as number;
            if (numOwners <= 1) {
                throw new Error('[[error:group-needs-owner]]');
            }
        }
        await Groups.leave(groupName, uid);
    };
};
